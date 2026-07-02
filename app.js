(function () {
  const STORAGE_KEYS = {
    catalog: "marketflow.catalog",
    sale: "marketflow.sale",
    settings: "marketflow.settings",
  };

  const state = {
    catalog: loadJson(STORAGE_KEYS.catalog, {}),
    saleItems: loadJson(STORAGE_KEYS.sale, []),
    mode: "add",
    tutorialVisible: true,
    lastCode: "",
    paymentMethod: "efectivo",
    paymentReceived: 0,
    pendingBarcode: null,
  };

  const scanner = {
    buffer: "",
    lastInputAt: 0,
    clearTimer: null,
  };

  const settings = loadJson(STORAGE_KEYS.settings, {
    tutorialVisible: true,
    paymentMethod: "efectivo",
  });

  state.tutorialVisible = settings.tutorialVisible !== false;
  state.paymentMethod = settings.paymentMethod || "efectivo";

  const elements = {
    addModeButton: document.getElementById("addModeButton"),
    removeModeButton: document.getElementById("removeModeButton"),
    modeLabel: document.getElementById("modeLabel"),
    lastCodeValue: document.getElementById("lastCodeValue"),
    catalogSize: document.getElementById("catalogSize"),
    scanMessage: document.getElementById("scanMessage"),
    invoiceBody: document.getElementById("invoiceBody"),
    itemCountBadge: document.getElementById("itemCountBadge"),
    totalBadge: document.getElementById("totalBadge"),
    subtotalValue: document.getElementById("subtotalValue"),
    distinctValue: document.getElementById("distinctValue"),
    unitsValue: document.getElementById("unitsValue"),
    tutorialCard: document.getElementById("tutorialCard"),
    toggleTutorial: document.getElementById("toggleTutorial"),
    collapseTutorial: document.getElementById("collapseTutorial"),
    newSaleButton: document.getElementById("newSaleButton"),
    paymentMethod: document.getElementById("paymentMethod"),
    paymentReceived: document.getElementById("paymentReceived"),
    paymentPrompt: document.getElementById("paymentPrompt"),
    paymentTotal: document.getElementById("paymentTotal"),
    paymentDue: document.getElementById("paymentDue"),
    paymentChange: document.getElementById("paymentChange"),
    completeSaleButton: document.getElementById("completeSaleButton"),
    registerModal: document.getElementById("registerModal"),
    registerForm: document.getElementById("registerForm"),
    barcodeField: document.getElementById("barcodeField"),
    nameField: document.getElementById("nameField"),
    priceField: document.getElementById("priceField"),
    cancelRegisterButton: document.getElementById("cancelRegisterButton"),
  };

  initialize();

  function initialize() {
    bindEvents();
    renderAll();
    announce("Sistema listo para escanear con el lector fisico.");
  }

  function bindEvents() {
    elements.addModeButton.addEventListener("click", function () {
      setMode("add");
    });

    elements.removeModeButton.addEventListener("click", function () {
      setMode("remove");
    });

    elements.toggleTutorial.addEventListener("click", function () {
      state.tutorialVisible = !state.tutorialVisible;
      persistSettings();
      renderTutorial();
    });

    elements.collapseTutorial.addEventListener("click", function () {
      state.tutorialVisible = false;
      persistSettings();
      renderTutorial();
    });

    elements.newSaleButton.addEventListener("click", function () {
      if (!state.saleItems.length) {
        announce("No hay productos en la venta actual.");
        return;
      }

      const confirmed = window.confirm(
        "Se reiniciara la factura actual. Los productos registrados seguiran guardados. Continuar?"
      );

      if (!confirmed) {
        return;
      }

      state.saleItems = [];
      state.paymentReceived = 0;
      elements.paymentReceived.value = "";
      saveSale();
      renderAll();
      announce("Venta reiniciada. Puedes comenzar a escanear de nuevo.");
    });

    elements.paymentMethod.addEventListener("change", function (event) {
      state.paymentMethod = event.target.value;
      persistSettings();
      renderPayment();
    });

    elements.paymentReceived.addEventListener("input", function (event) {
      const value = Number(event.target.value);
      state.paymentReceived = Number.isFinite(value) ? value : 0;
      renderPayment();
    });

    elements.completeSaleButton.addEventListener("click", function () {
      completeSale();
    });

    elements.registerForm.addEventListener("submit", function (event) {
      event.preventDefault();

      const barcode = elements.barcodeField.value.trim();
      const name = elements.nameField.value.trim();
      const price = Number(elements.priceField.value);

      if (!barcode || !name || !Number.isFinite(price) || price < 0) {
        announce("Completa los datos del producto antes de guardarlo.");
        return;
      }

      state.catalog[barcode] = {
        barcode: barcode,
        name: name,
        price: price,
      };

      saveCatalog();
      closeRegisterModal();
      addProductToSale(state.catalog[barcode]);
      renderAll();
      announce("Producto registrado y agregado a la factura.");
    });

    elements.cancelRegisterButton.addEventListener("click", function () {
      closeRegisterModal();
      announce("Registro cancelado. El codigo no se agrego a la venta.");
    });

    elements.invoiceBody.addEventListener("click", function (event) {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const barcode = button.getAttribute("data-barcode");
      const action = button.getAttribute("data-action");

      if (!barcode || !action) {
        return;
      }

      if (action === "remove-one") {
        removeProductFromSale(barcode);
      }

      if (action === "add-one") {
        const product = state.catalog[barcode];
        if (product) {
          addProductToSale(product);
        }
      }
    });

    document.addEventListener("keydown", handleScannerInput);
  }

  function handleScannerInput(event) {
    if (isModalOpen()) {
      return;
    }

    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    const key = event.key;
    const now = Date.now();
    const gap = now - scanner.lastInputAt;

    if (/^[0-9A-Za-z\-]$/.test(key)) {
      if (gap > 80) {
        scanner.buffer = "";
      }

      scanner.buffer += key;
      scanner.lastInputAt = now;
      resetScannerClearTimer();
      return;
    }

    if (key === "Enter" || key === "Tab") {
      if (scanner.buffer.length >= 6) {
        event.preventDefault();
        const barcode = scanner.buffer;
        scanner.buffer = "";
        processBarcode(barcode);
      }
      return;
    }

    if (gap > 80) {
      scanner.buffer = "";
    }
  }

  function resetScannerClearTimer() {
    window.clearTimeout(scanner.clearTimer);
    scanner.clearTimer = window.setTimeout(function () {
      scanner.buffer = "";
    }, 200);
  }

  function processBarcode(rawBarcode) {
    const barcode = String(rawBarcode).trim();

    if (!barcode) {
      return;
    }

    state.lastCode = barcode;
    elements.lastCodeValue.textContent = barcode;

    if (state.mode === "remove") {
      const removed = removeProductFromSale(barcode);
      if (!removed) {
        announce("Ese codigo no estaba en la venta actual para eliminarlo.");
      }
      return;
    }

    const product = state.catalog[barcode];

    if (!product) {
      openRegisterModal(barcode);
      announce("Codigo nuevo detectado. Completa el registro para continuar.");
      return;
    }

    addProductToSale(product);
    announce('Producto "' + product.name + '" agregado correctamente.');
  }

  function addProductToSale(product) {
    const existingItem = state.saleItems.find(function (item) {
      return item.barcode === product.barcode;
    });

    if (existingItem) {
      existingItem.quantity += 1;
    } else {
      state.saleItems.push({
        barcode: product.barcode,
        name: product.name,
        price: product.price,
        quantity: 1,
      });
    }

    saveSale();
    renderAll();
  }

  function removeProductFromSale(barcode) {
    const itemIndex = state.saleItems.findIndex(function (item) {
      return item.barcode === barcode;
    });

    if (itemIndex === -1) {
      return false;
    }

    const item = state.saleItems[itemIndex];
    item.quantity -= 1;

    if (item.quantity <= 0) {
      state.saleItems.splice(itemIndex, 1);
    }

    saveSale();
    renderAll();
    announce("Producto retirado de la factura actual.");
    return true;
  }

  function setMode(mode) {
    state.mode = mode;
    renderMode();

    if (mode === "add") {
      announce("Modo agregar activo. El siguiente escaneo suma productos.");
    } else {
      announce("Modo eliminar activo. El siguiente escaneo resta productos.");
    }
  }

  function renderAll() {
    renderMode();
    renderTutorial();
    renderCatalogCount();
    renderInvoice();
    renderPayment();
  }

  function renderMode() {
    const isAddMode = state.mode === "add";
    elements.addModeButton.classList.toggle("is-active", isAddMode);
    elements.removeModeButton.classList.toggle("is-active", !isAddMode);
    elements.addModeButton.setAttribute("aria-pressed", String(isAddMode));
    elements.removeModeButton.setAttribute("aria-pressed", String(!isAddMode));
    elements.modeLabel.textContent = isAddMode
      ? "Agregar productos"
      : "Eliminar productos";
  }

  function renderTutorial() {
    elements.tutorialCard.classList.toggle("hidden", !state.tutorialVisible);
    elements.toggleTutorial.textContent = state.tutorialVisible
      ? "Ocultar tutorial"
      : "Ver tutorial";
  }

  function renderCatalogCount() {
    const count = Object.keys(state.catalog).length;
    elements.catalogSize.textContent =
      count + (count === 1 ? " producto" : " productos");
  }

  function renderInvoice() {
    const totals = calculateTotals();

    elements.itemCountBadge.textContent =
      totals.units + (totals.units === 1 ? " item" : " items");
    elements.totalBadge.textContent = formatCurrency(totals.total);
    elements.subtotalValue.textContent = formatCurrency(totals.total);
    elements.distinctValue.textContent = String(totals.distinct);
    elements.unitsValue.textContent = String(totals.units);

    if (!state.saleItems.length) {
      elements.invoiceBody.innerHTML =
        '<tr class="empty-row"><td colspan="6">Escanea el primer producto para iniciar la factura.</td></tr>';
      return;
    }

    const rowsHtml = state.saleItems
      .map(function (item) {
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(item.barcode) +
          "</td>" +
          "<td>" +
          escapeHtml(item.name) +
          "</td>" +
          '<td><span class="qty-pill">' +
          item.quantity +
          "</span></td>" +
          "<td>" +
          formatCurrency(item.price) +
          "</td>" +
          "<td>" +
          formatCurrency(item.price * item.quantity) +
          "</td>" +
          '<td>' +
          '<button class="line-action" type="button" data-action="add-one" data-barcode="' +
          escapeHtml(item.barcode) +
          '">+1</button> ' +
          '<button class="line-action" type="button" data-action="remove-one" data-barcode="' +
          escapeHtml(item.barcode) +
          '">Quitar</button>' +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    elements.invoiceBody.innerHTML = rowsHtml;
  }

  function renderPayment() {
    const totals = calculateTotals();
    const received = Number.isFinite(state.paymentReceived) ? state.paymentReceived : 0;
    const due = Math.max(totals.total - received, 0);
    const change = Math.max(received - totals.total, 0);

    elements.paymentMethod.value = state.paymentMethod;
    elements.paymentTotal.textContent = formatCurrency(totals.total);
    elements.paymentDue.textContent = formatCurrency(due);
    elements.paymentChange.textContent = formatCurrency(change);

    if (!totals.units) {
      elements.completeSaleButton.disabled = true;
      elements.paymentPrompt.textContent =
        "No hay productos cargados. El sistema preguntara por el pago en cuanto inicies una venta.";
      return;
    }

    elements.completeSaleButton.disabled = false;

    if (state.paymentMethod === "efectivo") {
      if (received <= 0) {
        elements.paymentPrompt.textContent =
          "Llevas " +
          totals.units +
          " productos por " +
          formatCurrency(totals.total) +
          ". Indica cuanto entrega el cliente en efectivo.";
        return;
      }

      if (received < totals.total) {
        elements.paymentPrompt.textContent =
          "Pago parcial recibido. Faltan " + formatCurrency(totals.total - received) + ".";
        return;
      }

      elements.paymentPrompt.textContent =
        "Pago completo en efectivo registrado. Entrega " +
        formatCurrency(change) +
        " de cambio.";
      return;
    }

    if (state.paymentMethod === "tarjeta") {
      elements.paymentPrompt.textContent =
        "Cobro con tarjeta por " +
        formatCurrency(totals.total) +
        ". Verifica aprobacion del datafono o lector de pago.";
      return;
    }

    elements.paymentPrompt.textContent =
      "Transferencia seleccionada por " +
      formatCurrency(totals.total) +
      ". Confirma el comprobante antes de cerrar la venta.";
  }

  function completeSale() {
    const totals = calculateTotals();
    const received = Number.isFinite(state.paymentReceived) ? state.paymentReceived : 0;
    const due = Math.max(totals.total - received, 0);

    if (!totals.units) {
      announce("No hay productos para cerrar en esta venta.");
      return;
    }

    if (state.paymentMethod === "efectivo" && due > 0) {
      announce("El pago en efectivo aun esta incompleto.");
      return;
    }

    const confirmed = window.confirm(
      "Se cerrara la venta actual y se limpiara la factura. Deseas continuar?"
    );

    if (!confirmed) {
      return;
    }

    state.saleItems = [];
    state.paymentReceived = 0;
    elements.paymentReceived.value = "";
    saveSale();
    renderAll();
    announce("Venta cerrada correctamente. Lista para el siguiente cliente.");
  }

  function calculateTotals() {
    return state.saleItems.reduce(
      function (accumulator, item) {
        accumulator.total += item.price * item.quantity;
        accumulator.units += item.quantity;
        accumulator.distinct += 1;
        return accumulator;
      },
      { total: 0, units: 0, distinct: 0 }
    );
  }

  function openRegisterModal(barcode) {
    state.pendingBarcode = barcode;
    elements.barcodeField.value = barcode;
    elements.nameField.value = "";
    elements.priceField.value = "";
    elements.registerModal.classList.remove("hidden");
    elements.registerModal.setAttribute("aria-hidden", "false");
    window.setTimeout(function () {
      elements.nameField.focus();
    }, 30);
  }

  function closeRegisterModal() {
    state.pendingBarcode = null;
    elements.registerModal.classList.add("hidden");
    elements.registerModal.setAttribute("aria-hidden", "true");
    elements.registerForm.reset();
  }

  function saveCatalog() {
    localStorage.setItem(STORAGE_KEYS.catalog, JSON.stringify(state.catalog));
    renderCatalogCount();
  }

  function saveSale() {
    localStorage.setItem(STORAGE_KEYS.sale, JSON.stringify(state.saleItems));
  }

  function persistSettings() {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        tutorialVisible: state.tutorialVisible,
        paymentMethod: state.paymentMethod,
      })
    );
  }

  function announce(message) {
    elements.scanMessage.textContent = message;
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      maximumFractionDigits: 0,
    }).format(Number(value) || 0);
  }

  function loadJson(key, fallbackValue) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallbackValue;
    } catch (error) {
      return fallbackValue;
    }
  }

  function isModalOpen() {
    return !elements.registerModal.classList.contains("hidden");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
