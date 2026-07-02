import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  calculateTotals,
  formatCurrency,
  loadJson,
  removeSaleItem,
  saveJson,
  storageKeys,
  upsertSaleItem,
} from "./lib";
import { seedCatalog } from "./catalogSeed";
import type {
  PaymentMethod,
  ReaderMode,
  ScannerScanEvent,
  ScannerSource,
  ScannerStatusEvent,
  SaleItem,
  SerialConfig,
} from "./types";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type KioskPage = "intro" | "invoice" | "pay";

interface AppSettings {
  paymentMethod: PaymentMethod;
  selectedBank: string;
  scannerSource: ScannerSource;
  serialConfig: SerialConfig;
}

type ConfirmAction = "reset_sale" | "complete_sale";

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  action: ConfirmAction;
}

interface FavoriteItemRef {
  barcode: string;
  quantity: number;
}

interface FavoriteList {
  id: string;
  ownerId: string;
  createdAt: string;
  label: string;
  items: FavoriteItemRef[];
  totalUnits: number;
  totalDistinct: number;
}

const defaultSettings: AppSettings = {
  paymentMethod: "tarjeta",
  selectedBank: "Bancolombia",
  scannerSource: "keyboard",
  serialConfig: {
    port: "",
    baudrate: 9600,
  },
};

const seededFavoriteLists: FavoriteList[] = [
  {
    id: "1055000077-seed-basica",
    ownerId: "1055000077",
    createdAt: "2026-07-01T12:00:00.000Z",
    label: "Mercado basico · 01/07/2026",
    items: [
      { barcode: "7702127108029", quantity: 1 },
      { barcode: "7706371106862", quantity: 1 },
      { barcode: "7701001000024", quantity: 1 },
      { barcode: "7701001000047", quantity: 1 },
      { barcode: "7701001000043", quantity: 2 },
    ],
    totalUnits: 6,
    totalDistinct: 5,
  },
];

function normalizeSettings(
  raw: Partial<AppSettings> | null | undefined,
): AppSettings {
  const fallback = defaultSettings.paymentMethod;
  const rawMethod = String(raw?.paymentMethod ?? "");
  const paymentMethod: PaymentMethod =
    rawMethod === "tarjeta" || rawMethod === "qr_banco" || rawMethod === "nequi"
      ? rawMethod
      : rawMethod === "transferencia"
        ? "qr_banco"
        : fallback;

  return {
    ...defaultSettings,
    ...raw,
    paymentMethod,
    selectedBank: raw?.selectedBank || defaultSettings.selectedBank,
  };
}

function normalizeFavoriteLists(
  raw: FavoriteList[] | null | undefined,
): FavoriteList[] {
  const current = Array.isArray(raw) ? raw : [];
  const existingIds = new Set(current.map((favorite) => favorite.id));
  const missingSeeds = seededFavoriteLists.filter(
    (favorite) => !existingIds.has(favorite.id),
  );
  return [...current, ...missingSeeds];
}

const colombianBanks = [
  "Bancolombia",
  "Banco de Bogota",
  "Davivienda",
  "BBVA",
  "Banco de Occidente",
  "Banco Popular",
  "Banco AV Villas",
  "Scotiabank Colpatria",
  "Banco Caja Social",
  "Banco Agrario",
  "Itaú",
  "Lulo Bank",
];

const qrPattern = [
  "111111100011",
  "100000101011",
  "101110101101",
  "101110100001",
  "101110101111",
  "100000101001",
  "111111101101",
  "000100010001",
  "111001111101",
  "100101000101",
  "101111011101",
  "111000111111",
];

export default function App() {
  const catalog = seedCatalog;
  const [saleItems, setSaleItems] = useState<SaleItem[]>(() =>
    loadJson<SaleItem[]>(storageKeys.sale, []),
  );
  const [favoriteLists, setFavoriteLists] = useState<FavoriteList[]>(() =>
    normalizeFavoriteLists(loadJson<FavoriteList[]>(storageKeys.favorites, [])),
  );
  const [settings, setSettings] = useState<AppSettings>(() =>
    normalizeSettings(
      loadJson<Partial<AppSettings>>(storageKeys.settings, defaultSettings),
    ),
  );
  const [readerMode, setReaderMode] = useState<ReaderMode>("add");
  const [lastCode, setLastCode] = useState("Sin lectura todavia");
  const [lastScanSource, setLastScanSource] =
    useState<ScannerSource>("keyboard");
  const [statusMessage, setStatusMessage] = useState(
    "Sistema listo para escanear con el lector fisico.",
  );
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialStatus, setSerialStatus] = useState("Modo teclado HID listo.");
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(
    null,
  );
  const [startFavoritesOpen, setStartFavoritesOpen] = useState(false);
  const [startFavoritesCedula, setStartFavoritesCedula] = useState("");
  const [saveFavoriteItems, setSaveFavoriteItems] = useState<SaleItem[] | null>(
    null,
  );
  const [saveFavoriteCedula, setSaveFavoriteCedula] = useState("");
  const [currentPage, setCurrentPage] = useState<KioskPage>(() =>
    getPageFromHash(window.location.hash),
  );

  const scannerBuffer = useRef("");
  const lastInputAt = useRef(0);
  const readerModeRef = useRef(readerMode);
  const saleItemsRef = useRef(saleItems);
  const scannerSourceRef = useRef(settings.scannerSource);
  const modalBlockRef = useRef(false);

  useEffect(() => {
    readerModeRef.current = readerMode;
  }, [readerMode]);

  useEffect(() => {
    saleItemsRef.current = saleItems;
  }, [saleItems]);

  useEffect(() => {
    scannerSourceRef.current = settings.scannerSource;
  }, [settings.scannerSource]);

  useEffect(() => {
    modalBlockRef.current =
      Boolean(pendingBarcode) ||
      helpOpen ||
      Boolean(confirmDialog) ||
      startFavoritesOpen ||
      Boolean(saveFavoriteItems);
  }, [
    confirmDialog,
    helpOpen,
    pendingBarcode,
    saveFavoriteItems,
    startFavoritesOpen,
  ]);

  useEffect(() => {
    const hc = navigator.hardwareConcurrency || 4;
    const dm = (navigator as { deviceMemory?: number }).deviceMemory;
    const lowPower = hc <= 4 || (dm !== undefined && dm <= 2);
    document.documentElement.classList.toggle("low-power", lowPower);
  }, []);

  useEffect(() => {
    saveJson(storageKeys.catalog, seedCatalog);
  }, []);
  useEffect(() => {
    setFavoriteLists((current) => normalizeFavoriteLists(current));
  }, []);
  useDeferredJsonStorage(storageKeys.sale, saleItems, 80);
  useDeferredJsonStorage(storageKeys.settings, settings, 140);
  useDeferredJsonStorage(storageKeys.favorites, favoriteLists, 220);

  useEffect(() => {
    if (settings.scannerSource === "keyboard" && serialConnected) {
      void disconnectSerial();
    }
  }, [serialConnected, settings.scannerSource]);

  useEffect(() => {
    void refreshSerialPorts();
  }, []);

  useEffect(() => {
    if (isTauriRuntime) {
      return;
    }

    const onHashChange = () => {
      setCurrentPage(getPageFromHash(window.location.hash));
    };

    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    let unlistenStatus: UnlistenFn | undefined;
    let unlistenScan: UnlistenFn | undefined;

    const setup = async () => {
      unlistenStatus = await listen<ScannerStatusEvent>(
        "scanner://status",
        (event) => {
          const payload = event.payload;
          setSerialConnected(payload.connected);
          setSerialStatus(payload.message);
          setStatusMessage(payload.message);
        },
      );

      unlistenScan = await listen<ScannerScanEvent>(
        "scanner://scan",
        (event) => {
          if (modalBlockRef.current) {
            return;
          }
          processBarcode(event.payload.code, event.payload.source);
        },
      );
    };

    void setup();

    return () => {
      void unlistenStatus?.();
      void unlistenScan?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (scannerSourceRef.current !== "keyboard") {
        return;
      }

      if (modalBlockRef.current) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.ctrlKey || event.altKey || event.metaKey) {
        return;
      }

      const now = performance.now();
      const gap = now - lastInputAt.current;

      if (/^[0-9A-Za-z-]$/.test(event.key)) {
        if (gap > 80) {
          scannerBuffer.current = "";
        }

        scannerBuffer.current += event.key;
        lastInputAt.current = now;
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        if (scannerBuffer.current.trim().length >= 6) {
          const code = scannerBuffer.current.trim();
          scannerBuffer.current = "";
          event.preventDefault();
          processBarcode(code, "keyboard");
        }
        return;
      }

      if (gap > 80) {
        scannerBuffer.current = "";
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const totals = useMemo(() => calculateTotals(saleItems), [saleItems]);
  const paymentDue = 0;
  const paymentChange = 0;
  const normalizedStartFavoritesCedula = normalizeCedula(startFavoritesCedula);
  const matchingFavorites = useMemo(
    () =>
      normalizedStartFavoritesCedula
        ? favoriteLists
            .filter(
              (favorite) => favorite.ownerId === normalizedStartFavoritesCedula,
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        : [],
    [favoriteLists, normalizedStartFavoritesCedula],
  );

  useEffect(() => {
    if (!saleItems.length && currentPage === "pay") {
      goToPage("intro");
    }
  }, [currentPage, saleItems.length]);

  function persistSettings(next: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...next }));
  }

  function announce(message: string) {
    setStatusMessage(message);
  }

  function goToPage(page: KioskPage) {
    if (!isTauriRuntime && window.location.hash !== `#/${page}`) {
      window.location.hash = `/${page}`;
    }
    setCurrentPage(page);
  }

  function processBarcode(code: string, source: ScannerSource) {
    if (modalBlockRef.current) {
      return;
    }

    const currentReaderMode = readerModeRef.current;
    const currentSaleItems = saleItemsRef.current;
    const barcode = code.trim();
    if (!barcode) {
      return;
    }

    setLastCode(barcode);
    setLastScanSource(source);

    if (currentReaderMode === "remove") {
      const exists = currentSaleItems.some((item) => item.barcode === barcode);
      if (!exists) {
        announce("Ese codigo no esta en la venta actual para quitarlo.");
        return;
      }

      setSaleItems((current) => removeSaleItem(current, barcode));
      announce("Producto retirado de la factura actual.");
      goToPage("invoice");
      return;
    }

    const product = catalog[barcode];
    if (!product) {
      setPendingBarcode(barcode);
      announce("Producto no encontrado. Solicita ayuda a un asesor.");
      return;
    }

    setSaleItems((current) => upsertSaleItem(current, product));
    announce(`Producto "${product.name}" agregado correctamente.`);
    goToPage("invoice");
  }

  function closeUnknownProductNotice() {
    setPendingBarcode(null);
    announce("Producto no agregado. Solicita ayuda a un asesor.");
  }

  function openStartFavoritesDialog() {
    setStartFavoritesCedula("");
    setStartFavoritesOpen(true);
    goToPage("intro");
    announce("Puedes cargar una lista favorita o empezar una compra nueva.");
  }

  function closeStartFavoritesDialog() {
    setStartFavoritesOpen(false);
    setStartFavoritesCedula("");
  }

  function openConfirmDialog(config: ConfirmDialogState) {
    setConfirmDialog(config);
  }

  function closeConfirmDialog() {
    setConfirmDialog(null);
  }

  function handleConfirmDialog() {
    if (!confirmDialog) {
      return;
    }

    const action = confirmDialog.action;
    setConfirmDialog(null);

    if (action === "reset_sale") {
      setSaleItems([]);
      setReaderMode("add");
      openStartFavoritesDialog();
      return;
    }

    setSaveFavoriteItems(saleItems.map((item) => ({ ...item })));
    setSaveFavoriteCedula("");
    announce(
      "Pago confirmado. Decide si deseas guardar esta compra en favoritos.",
    );
  }

  function toggleReaderMode(next: ReaderMode) {
    setReaderMode(next);
    announce(
      next === "add"
        ? "Modo agregar activo. El siguiente escaneo suma productos."
        : "Modo eliminar activo. El siguiente escaneo resta productos.",
    );
  }

  function addUnit(barcode: string) {
    const product = catalog[barcode];
    if (!product) {
      return;
    }
    setSaleItems((current) => upsertSaleItem(current, product));
  }

  function removeUnit(barcode: string) {
    setSaleItems((current) => removeSaleItem(current, barcode));
  }

  function startEmptySale() {
    closeStartFavoritesDialog();
    setSaleItems([]);
    setReaderMode("add");
    announce("Venta nueva lista. Escanea el primer producto.");
    goToPage("invoice");
  }

  function loadFavoriteIntoSale(favorite: FavoriteList) {
    const loadedItems = favorite.items
      .map((item) => {
        const product = catalog[item.barcode];
        return product ? { ...product, quantity: item.quantity } : null;
      })
      .filter((item): item is SaleItem => item !== null);

    if (!loadedItems.length) {
      announce("Esta lista favorita ya no tiene productos disponibles.");
      return;
    }

    closeStartFavoritesDialog();
    setSaleItems(loadedItems);
    setReaderMode("add");
    setLastCode("Lista favorita cargada");
    setLastScanSource("keyboard");
    announce(`Lista favorita "${favorite.label}" cargada correctamente.`);
    goToPage("invoice");
  }

  function finalizeSale(
    message = "Venta cerrada correctamente. Lista para el siguiente cliente.",
  ) {
    setSaveFavoriteItems(null);
    setSaveFavoriteCedula("");
    setSaleItems([]);
    setReaderMode("add");
    announce(message);
    goToPage("intro");
  }

  function skipSaveFavorite() {
    finalizeSale();
  }

  function saveCurrentFavorite() {
    if (!saveFavoriteItems?.length) {
      finalizeSale();
      return;
    }

    const ownerId = normalizeCedula(saveFavoriteCedula);
    if (!ownerId) {
      announce("Ingresa una cédula válida para guardar la lista favorita.");
      return;
    }

    const createdAt = new Date().toISOString();
    const favorite: FavoriteList = {
      id: `${ownerId}-${Date.now()}`,
      ownerId,
      createdAt,
      label: buildFavoriteLabel(saveFavoriteItems, createdAt),
      items: saveFavoriteItems.map((item) => ({
        barcode: item.barcode,
        quantity: item.quantity,
      })),
      totalUnits: saveFavoriteItems.reduce(
        (total, item) => total + item.quantity,
        0,
      ),
      totalDistinct: saveFavoriteItems.length,
    };

    setFavoriteLists((current) => [favorite, ...current]);
    finalizeSale(
      "Compra guardada en favoritos. Lista para el siguiente cliente.",
    );
  }

  function newSale() {
    if (!saleItems.length) {
      openStartFavoritesDialog();
      return;
    }

    openConfirmDialog({
      title: "Iniciar una nueva compra",
      message:
        "Se limpiara la factura actual y podras comenzar con el siguiente cliente.",
      confirmLabel: "Nueva compra",
      action: "reset_sale",
    });
  }

  function completeSale() {
    if (!saleItems.length) {
      announce("No hay productos para cerrar en esta venta.");
      return;
    }

    openConfirmDialog({
      title: "Confirmar pago",
      message:
        "Se confirmara el cobro y se limpiara la factura actual para el siguiente cliente.",
      confirmLabel: "Confirmar pago",
      action: "complete_sale",
    });
  }

  async function refreshSerialPorts() {
    if (!isTauriRuntime) {
      setSerialStatus(
        "Vista web activa. Los puertos seriales se listan solo dentro de Tauri.",
      );
      return;
    }

    try {
      const ports = await invoke<string[]>("list_serial_ports");
      setSerialPorts(ports);
      if (!settings.serialConfig.port && ports[0]) {
        persistSettings({
          serialConfig: { ...settings.serialConfig, port: ports[0] },
        });
      }
    } catch (error) {
      setSerialStatus(
        `No fue posible listar puertos seriales: ${String(error)}`,
      );
    }
  }

  async function connectSerial() {
    if (!isTauriRuntime) {
      setSerialStatus(
        "La conexion serial solo esta disponible en el runtime Tauri.",
      );
      return;
    }

    if (!settings.serialConfig.port) {
      announce("Selecciona un puerto serial antes de conectar el lector.");
      return;
    }

    try {
      await invoke("connect_serial_scanner", {
        config: settings.serialConfig,
      });
      persistSettings({ scannerSource: "serial" });
      setSerialStatus(
        `Conectando lector serial en ${settings.serialConfig.port}...`,
      );
    } catch (error) {
      setSerialStatus(`No se pudo conectar el lector serial: ${String(error)}`);
    }
  }

  async function disconnectSerial() {
    if (!isTauriRuntime) {
      return;
    }

    try {
      await invoke("disconnect_serial_scanner");
      setSerialConnected(false);
      setSerialStatus("Lector serial desconectado.");
    } catch (error) {
      setSerialStatus(
        `No se pudo desconectar el lector serial: ${String(error)}`,
      );
    }
  }

  function paymentPrompt() {
    if (!saleItems.length) {
      return "No hay productos cargados. El sistema preguntará por el pago cuando inicies una venta.";
    }

    if (settings.paymentMethod === "tarjeta") {
      return `Cobro con tarjeta por ${formatCurrency(totals.total)}. Pide al cliente usar el datafono y confirma cuando la transaccion sea aprobada.`;
    }

    if (settings.paymentMethod === "qr_banco") {
      return `Cobro por QR bancario con ${settings.selectedBank}. Muestra el QR, espera el comprobante y confirma el pago.`;
    }

    return `Cobro por QR Nequi por ${formatCurrency(totals.total)}. Muestra el QR, espera la confirmación y luego cierra la venta.`;
  }

  function scanHeadline() {
    if (readerMode === "remove") {
      return "Escanee el producto que desea quitar";
    }

    if (!saleItems.length) {
      return "Escanee su primer producto";
    }

    return "Siga escaneando sus productos";
  }

  function scanSupportText() {
    if (readerMode === "remove") {
      return "Cada lectura resta una unidad del carrito actual.";
    }

    if (settings.scannerSource === "serial") {
      return serialConnected
        ? "El lector serial esta conectado y listo para recibir productos."
        : "Si el lector no responde, solicita ayuda al personal.";
    }

    return "Pase el código por el lector y el producto se agregará automaticamente.";
  }

  function summaryLabel() {
    if (!saleItems.length) {
      return "Aún no hay productos cargados";
    }

    return `${totals.units} productos agregados correctamente`;
  }

  const orderedItems = useMemo(
    () => [...saleItems].sort((a, b) => a.name.localeCompare(b.name, "es")),
    [saleItems],
  );
  const paymentChannelLabel =
    settings.paymentMethod === "tarjeta"
      ? "Datafono"
      : settings.paymentMethod === "qr_banco"
        ? settings.selectedBank
        : "QR Nequi";
  const paymentExperience =
    settings.paymentMethod === "tarjeta"
      ? {
          kicker: "Tarjeta",
          title: "Pida al cliente usar el datafono.",
          description:
            "Cliente acerca, inserta o desliza la tarjeta y tu confirmas cuando el pago sea aprobado.",
          steps: [
            "Acerque o inserte la tarjeta",
            "Espere aprobacion del pago",
            "Confirme para cerrar la compra",
          ],
        }
      : settings.paymentMethod === "qr_banco"
        ? {
            kicker: "QR bancario",
            title: settings.selectedBank,
            description:
              "Muestre el QR del banco seleccionado y valide el comprobante antes de cerrar la venta.",
            steps: [
              "Muestre el QR del banco",
              "Cliente paga desde su app",
              "Revise comprobante y confirme",
            ],
            qrTitle: "QR listo para mostrar",
            qrSubtitle: `Pago por ${settings.selectedBank}`,
            qrAccent: "bank" as const,
          }
        : {
            kicker: "QR Nequi",
            title: "Nequi",
            description:
              "Cliente escanea con Nequi y tu confirmas el pago recibido para terminar la compra.",
            steps: [
              "Muestre el QR Nequi",
              "Cliente escanea y paga",
              "Cierre la venta al verificar",
            ],
            qrTitle: "QR Nequi",
            qrSubtitle: "Cliente escanea desde la app Nequi",
            qrAccent: "nequi" as const,
          };
  const introSteps = [
    {
      key: "scan",
      number: "1",
      title: "Escanee",
      text: "Pase un producto a la vez.",
    },
    {
      key: "review",
      number: "2",
      title: "Revise",
      text: "Confirme la compra antes de pagar.",
    },
    {
      key: "pay",
      number: "3",
      title: "Pague",
      text: "Si algo sale mal, use Ayuda.",
    },
  ];
  const helpTips = [
    "Pase solo un producto a la vez.",
    "Revise la compra antes de pagar.",
    "Si algo sale mal, pida ayuda al personal.",
  ];

  return (
    <div className="app-shell app-shell-slides">
      <main className="slide-shell">
        {currentPage === "intro" && (
          <section className="card kiosk-card slide-page intro-page">
            <div className="hero kiosk-hero slide-hero intro-hero-panel">
              <div className="hero-copy-block intro-message-panel">
                <p className="eyebrow">Caja rapida tactil</p>
                <h1>Escanee sus productos</h1>
                <p className="hero-copy">
                  Pase, revise y pague sin filas ni pasos de mas.
                </p>
                <div className="flow-steps">
                  <StepPill
                    number="1"
                    label="Inicio"
                    active={currentPage === "intro"}
                    onClick={() => goToPage("intro")}
                  />
                  <StepPill
                    number="2"
                    label="Factura"
                    active={false}
                    done={saleItems.length > 0}
                    onClick={() => saleItems.length > 0 && goToPage("invoice")}
                  />
                  <StepPill
                    number="3"
                    label="Pago"
                    active={false}
                    done={saleItems.length > 0 && paymentDue <= 0}
                    onClick={() => saleItems.length > 0 && goToPage("pay")}
                  />
                </div>
              </div>
              <div className="hero-actions kiosk-actions intro-action-panel">
                <div className="intro-visual-stage" aria-hidden="true">
                  <div className="intro-visual-card scan">
                    <div className="intro-icon scan-icon" />
                    <strong>Pase</strong>
                  </div>
                  <div className="intro-arrow" />
                  <div className="intro-visual-card review">
                    <div className="intro-icon review-icon" />
                    <strong>Revise</strong>
                  </div>
                  <div className="intro-arrow" />
                  <div className="intro-visual-card pay">
                    <div className="intro-icon pay-icon" />
                    <strong>Pague</strong>
                  </div>
                </div>
                <div className="intro-start-block">
                  <button
                    className="primary-button touch-button intro-primary-action"
                    onClick={newSale}
                    type="button"
                  >
                    Comenzar compra
                  </button>
                  {saleItems.length > 0 && (
                    <button
                      className="secondary-button touch-button"
                      onClick={() => goToPage("invoice")}
                      type="button"
                    >
                      Continuar compra actual
                    </button>
                  )}
                  <div className="intro-utility-actions">
                    <button
                      className="secondary-button touch-button"
                      onClick={() => setHelpOpen(true)}
                      type="button"
                    >
                      Ver ayuda
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="intro-guide-grid">
              {introSteps.map((step) => (
                <article
                  className={`intro-guide-card intro-guide-${step.key}`}
                  key={step.number}
                >
                  <strong>{step.number}</strong>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {currentPage === "invoice" && (
          <section className="card kiosk-card slide-page invoice-page">
            <div className="card-head">
              <div>
                <p className="section-tag">Factura</p>
                <h2>Revise la factura y siga escaneando</h2>
              </div>
              <div className="badge accent">{formatCurrency(totals.total)}</div>
            </div>

            <div className="invoice-topbar">
              <div className="flow-steps compact-steps">
                <StepPill
                  number="1"
                  label="Inicio"
                  active={false}
                  done
                  onClick={() => goToPage("intro")}
                />
                <StepPill
                  number="2"
                  label="Factura"
                  active
                  onClick={() => goToPage("invoice")}
                />
                <StepPill
                  number="3"
                  label="Pago"
                  active={false}
                  done={paymentDue <= 0 && saleItems.length > 0}
                  onClick={() => saleItems.length > 0 && goToPage("pay")}
                />
              </div>

              <div className="mode-switch touch-mode-switch">
                <button
                  className={
                    readerMode === "add"
                      ? "chip active touch-chip"
                      : "chip touch-chip"
                  }
                  onClick={() => toggleReaderMode("add")}
                  type="button"
                >
                  Modo agregar
                </button>
                <button
                  className={
                    readerMode === "remove"
                      ? "chip active touch-chip warning"
                      : "chip touch-chip warning"
                  }
                  onClick={() => toggleReaderMode("remove")}
                  type="button"
                >
                  Quitar producto
                </button>
              </div>
            </div>

            <div className="invoice-layout">
              <div className="invoice-stage">
                <div className="scan-stage-main">
                  <p className="scan-stage-kicker">Zona de lectura</p>
                  <strong className="scan-stage-title">{scanHeadline()}</strong>
                  <p className="scan-stage-text">{scanSupportText()}</p>
                  <div className="scan-stage-status">
                    <div>
                      <span>Ultimo codigo leido</span>
                      <strong>{lastCode}</strong>
                    </div>
                    <div>
                      <span>Estado</span>
                      <strong>{statusMessage}</strong>
                    </div>
                  </div>
                </div>

                <div className="scan-stage-side">
                  <StatCard
                    title="Modo actual"
                    value={
                      readerMode === "add"
                        ? "Agregar productos"
                        : "Quitar productos"
                    }
                  />
                  <StatCard
                    title="Origen de lectura"
                    value={
                      lastScanSource === "keyboard"
                        ? "Lector tipo teclado"
                        : "Lector serial"
                    }
                  />
                  <StatCard
                    title="Catalogo"
                    value={`${Object.keys(catalog).length} productos registrados`}
                  />
                </div>
              </div>

              <section className="invoice-panel receipt-panel">
                <div className="invoice-panel-head">
                  <div>
                    <p className="section-tag">Carrito actual</p>
                    <h3>{summaryLabel()}</h3>
                  </div>
                  <span className="badge">{totals.units} items</span>
                </div>

                <div className="invoice-items receipt-body">
                  {orderedItems.length ? (
                    orderedItems.map((item) => (
                      <InvoiceItemRow
                        item={item}
                        key={item.barcode}
                        onAdd={addUnit}
                        onRemove={removeUnit}
                      />
                    ))
                  ) : (
                    <div className="invoice-empty">
                      <strong>No hay productos en la factura.</strong>
                      <p>
                        Pase el primer producto por el lector y aparecera aqui
                        automaticamente.
                      </p>
                    </div>
                  )}
                </div>

                <div className="invoice-summary receipt-summary">
                  <MiniCard label="Productos" value={String(totals.units)} />
                  <MiniCard
                    label="Referencias"
                    value={String(totals.distinct)}
                  />
                  <MiniCard
                    label="Total"
                    value={formatCurrency(totals.total)}
                  />
                </div>
              </section>
            </div>

            <div className="page-actions split">
              <button
                className="secondary-button touch-button"
                onClick={() => goToPage("intro")}
                type="button"
              >
                Volver al inicio
              </button>
              <button
                className="primary-button touch-button wide"
                disabled={!saleItems.length}
                onClick={() => goToPage("pay")}
                type="button"
              >
                Continuar al pago
              </button>
            </div>
          </section>
        )}

        {currentPage === "pay" && (
          <section className="card kiosk-card slide-page pay-page">
            <div className="card-head">
              <div>
                <p className="section-tag">Pago</p>
                <h2>Elija como pagar</h2>
              </div>
            </div>

            <div className="flow-steps compact-steps">
              <StepPill
                number="1"
                label="Inicio"
                active={false}
                done
                onClick={() => goToPage("intro")}
              />
              <StepPill
                number="2"
                label="Factura"
                active={false}
                done
                onClick={() => goToPage("invoice")}
              />
              <StepPill
                number="3"
                label="Pago"
                active
                done={paymentDue <= 0}
                onClick={() => goToPage("pay")}
              />
            </div>

            <div className="pay-layout">
              <div className="pay-main">
                <div className="payment-prompt-card">
                  <div className="payment-prompt-copy">
                    <span className="payment-prompt-kicker">
                      Resumen del cobro
                    </span>
                    <p className="payment-prompt">{paymentPrompt()}</p>
                  </div>
                  <strong className="payment-total-highlight">
                    {formatCurrency(totals.total)}
                  </strong>
                </div>

                <div className="field-group payment-block">
                  <label>Metodo de pago</label>
                  <div className="payment-method-grid">
                    {(
                      [
                        ["tarjeta", "Tarjeta"],
                        ["qr_banco", "QR banco"],
                        ["nequi", "QR Nequi"],
                      ] as Array<[PaymentMethod, string]>
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        className={
                          settings.paymentMethod === value
                            ? "payment-method active"
                            : "payment-method"
                        }
                        onClick={() =>
                          persistSettings({ paymentMethod: value })
                        }
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {settings.paymentMethod === "qr_banco" && (
                  <div className="field-group payment-block">
                    <label>Banco para QR</label>
                    <div className="bank-grid">
                      {colombianBanks.map((bank) => (
                        <button
                          key={bank}
                          className={
                            settings.selectedBank === bank
                              ? "bank-option active"
                              : "bank-option"
                          }
                          onClick={() =>
                            persistSettings({ selectedBank: bank })
                          }
                          type="button"
                        >
                          {bank}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="pay-side">
                <div className="checkout-summary">
                  <MiniCard
                    label="Total a cobrar"
                    value={formatCurrency(totals.total)}
                  />
                  <MiniCard label="Canal" value={paymentChannelLabel} />
                  <MiniCard label="Estado" value="Listo para confirmar" />
                </div>

                <article className="payment-visual-card">
                  <span className="payment-visual-kicker">
                    {paymentExperience.kicker}
                  </span>
                  <strong>{paymentExperience.title}</strong>
                  <p className="payment-visual-copy">
                    {paymentExperience.description}
                  </p>
                  {paymentExperience.qrTitle &&
                    paymentExperience.qrSubtitle && (
                      <QrPreview
                        accent={paymentExperience.qrAccent}
                        subtitle={paymentExperience.qrSubtitle}
                        title={paymentExperience.qrTitle}
                      />
                    )}
                  <div className="payment-steps">
                    {paymentExperience.steps.map((step) => (
                      <span key={step}>{step}</span>
                    ))}
                  </div>
                </article>

                <div className="payment-action-stack">
                  <div className="page-actions-group">
                    <button
                      className="secondary-button touch-button"
                      onClick={() => goToPage("invoice")}
                      type="button"
                    >
                      Volver a la factura
                    </button>
                  </div>
                  <button
                    className="primary-button touch-button wide"
                    disabled={!saleItems.length}
                    onClick={completeSale}
                    type="button"
                  >
                    Confirmar pago y cerrar venta
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {pendingBarcode && (
        <div className="modal">
          <div className="modal-backdrop" onClick={closeUnknownProductNotice} />
          <div className="modal-card touch-modal">
            <p className="section-tag">Producto no disponible</p>
            <h2>Producto no reconocido</h2>
            <p className="modal-copy">
              Este producto no existe en el catalogo de la caja rapida. Por
              favor, habla con un asesor para recibir ayuda.
            </p>
            <div className="field-group">
              <label>Codigo de barras</label>
              <input readOnly type="text" value={pendingBarcode} />
            </div>
            <div className="help-card-grid single-help-card">
              <article className="intro-help-card help-card">
                <span>Que hacer ahora</span>
                <p>
                  No siga intentando este codigo. Solicite apoyo del asesor de
                  tienda.
                </p>
              </article>
            </div>
            <div className="modal-actions">
              <button
                className="primary-button touch-button wide"
                onClick={closeUnknownProductNotice}
                type="button"
              >
                Entendido
              </button>
            </div>
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="modal">
          <div className="modal-backdrop" onClick={() => setHelpOpen(false)} />
          <div className="modal-card touch-modal help-modal">
            <p className="section-tag">Ayuda</p>
            <h2>Como comprar aqui</h2>
            <div className="help-visual-row" aria-hidden="true">
              <div className="intro-visual-card scan">
                <div className="intro-icon scan-icon" />
                <strong>Pase</strong>
              </div>
              <div className="intro-arrow" />
              <div className="intro-visual-card review">
                <div className="intro-icon review-icon" />
                <strong>Revise</strong>
              </div>
              <div className="intro-arrow" />
              <div className="intro-visual-card pay">
                <div className="intro-icon pay-icon" />
                <strong>Pague</strong>
              </div>
            </div>
            <div className="help-card-grid">
              {helpTips.map((tip, index) => (
                <article className="intro-help-card help-card" key={tip}>
                  <span>Paso {index + 1}</span>
                  <p>{tip}</p>
                </article>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="primary-button touch-button wide"
                onClick={() => setHelpOpen(false)}
                type="button"
              >
                Cerrar ayuda
              </button>
            </div>
          </div>
        </div>
      )}

      {startFavoritesOpen && (
        <div className="modal">
          <div className="modal-backdrop" onClick={closeStartFavoritesDialog} />
          <div className="modal-card touch-modal favorites-modal">
            <p className="section-tag">Favoritos</p>
            <h2>¿Ya tienes una lista guardada?</h2>
            <p className="modal-copy">
              Ingresa la cédula para ver tus compras favoritas o empieza una
              compra nueva.
            </p>
            <div className="field-group">
              <label>Cédula</label>
              <input
                inputMode="numeric"
                onChange={(event) =>
                  setStartFavoritesCedula(normalizeCedula(event.target.value))
                }
                placeholder="Ej. 1032456789"
                type="text"
                value={startFavoritesCedula}
              />
            </div>
            {normalizedStartFavoritesCedula ? (
              matchingFavorites.length ? (
                <div className="favorites-list">
                  {matchingFavorites.map((favorite) => (
                    <button
                      className="favorite-card"
                      key={favorite.id}
                      onClick={() => loadFavoriteIntoSale(favorite)}
                      type="button"
                    >
                      <div className="favorite-card-copy">
                        <strong>{favorite.label}</strong>
                        <span>{formatFavoriteDate(favorite.createdAt)}</span>
                      </div>
                      <div className="favorite-card-stats">
                        <span>{favorite.totalUnits} productos</span>
                        <span>{favorite.totalDistinct} referencias</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <article className="info-card">
                  <strong>No hay favoritos guardados con esa cédula.</strong>
                  <p>
                    Puedes empezar una compra nueva y guardarla al finalizar.
                  </p>
                </article>
              )
            ) : (
              <article className="info-card">
                <strong>Ingresa una cédula para buscar listas.</strong>
                <p>Si prefieres, puedes continuar sin favoritos.</p>
              </article>
            )}
            <div className="modal-actions favorites-actions">
              <button
                className="secondary-button touch-button"
                onClick={closeStartFavoritesDialog}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="primary-button touch-button"
                onClick={startEmptySale}
                type="button"
              >
                Empezar sin favoritos
              </button>
            </div>
          </div>
        </div>
      )}

      {saveFavoriteItems && (
        <div className="modal">
          <div className="modal-backdrop" onClick={skipSaveFavorite} />
          <div className="modal-card touch-modal favorites-modal">
            <p className="section-tag">Guardar favorito</p>
            <h2>¿Deseas guardar esta compra?</h2>
            <p className="modal-copy">
              Guarda esta lista con una cédula para volver a cargarla en una
              próxima compra.
            </p>
            <div className="favorites-summary">
              <MiniCard
                label="Productos"
                value={String(
                  saveFavoriteItems.reduce(
                    (total, item) => total + item.quantity,
                    0,
                  ),
                )}
              />
              <MiniCard
                label="Referencias"
                value={String(saveFavoriteItems.length)}
              />
              <MiniCard
                label="Total"
                value={formatCurrency(
                  saveFavoriteItems.reduce(
                    (total, item) => total + item.price * item.quantity,
                    0,
                  ),
                )}
              />
            </div>
            <div className="field-group">
              <label>Cédula para guardar</label>
              <input
                inputMode="numeric"
                onChange={(event) =>
                  setSaveFavoriteCedula(normalizeCedula(event.target.value))
                }
                placeholder="Ej. 1032456789"
                type="text"
                value={saveFavoriteCedula}
              />
            </div>
            <div className="modal-actions favorites-actions">
              <button
                className="secondary-button touch-button"
                onClick={skipSaveFavorite}
                type="button"
              >
                No guardar
              </button>
              <button
                className="primary-button touch-button"
                onClick={saveCurrentFavorite}
                type="button"
              >
                Guardar favorita
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="modal">
          <div className="modal-backdrop" onClick={closeConfirmDialog} />
          <div className="modal-card touch-modal confirm-modal">
            <p className="section-tag">Confirmacion</p>
            <h2>{confirmDialog.title}</h2>
            <p className="modal-copy">{confirmDialog.message}</p>
            <div className="modal-actions confirm-actions">
              <button
                className="secondary-button touch-button"
                onClick={closeConfirmDialog}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="primary-button touch-button"
                onClick={handleConfirmDialog}
                type="button"
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const QrPreview = memo(function QrPreview({
  title,
  subtitle,
  accent = "bank",
}: {
  title: string;
  subtitle: string;
  accent?: "bank" | "nequi";
}) {
  return (
    <div className={accent === "nequi" ? "qr-preview nequi" : "qr-preview"}>
      <div className="qr-box" aria-hidden="true">
        {qrPattern
          .join("")
          .split("")
          .map((cell, index) => (
            <span
              className={cell === "1" ? "qr-cell filled" : "qr-cell"}
              key={`${accent}-${index}`}
            />
          ))}
      </div>
      <div className="qr-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
    </div>
  );
});

const StatCard = memo(function StatCard({
  title,
  value,
  accent = false,
}: {
  title: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <article className={accent ? "stat-card accent" : "stat-card"}>
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
});

const MiniCard = memo(function MiniCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="mini-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
});

const StepPill = memo(function StepPill({
  number,
  label,
  active,
  done,
  onClick,
}: {
  number: string;
  label: string;
  active?: boolean;
  done?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={
        active ? "step-pill active" : done ? "step-pill done" : "step-pill"
      }
      onClick={onClick}
      type="button"
    >
      <strong>{number}</strong>
      <span>{label}</span>
    </button>
  );
});

const InvoiceItemRow = memo(function InvoiceItemRow({
  item,
  onAdd,
  onRemove,
}: {
  item: SaleItem;
  onAdd: (barcode: string) => void;
  onRemove: (barcode: string) => void;
}) {
  return (
    <article className="invoice-item">
      <div className="invoice-item-copy">
        <strong>{item.name}</strong>
        <span>{formatCurrency(item.price)} c/u</span>
      </div>
      <div className="invoice-item-controls">
        <button
          className="qty-action"
          onClick={() => onRemove(item.barcode)}
          type="button"
        >
          -
        </button>
        <span className="qty-pill">{item.quantity}</span>
        <button
          className="qty-action accent"
          onClick={() => onAdd(item.barcode)}
          type="button"
        >
          +
        </button>
      </div>
      <strong className="invoice-item-total">
        {formatCurrency(item.price * item.quantity)}
      </strong>
    </article>
  );
});

function getPageFromHash(hash: string): KioskPage {
  const normalized = hash.replace(/^#\//, "");
  if (
    normalized === "intro" ||
    normalized === "invoice" ||
    normalized === "pay"
  ) {
    return normalized;
  }
  return "intro";
}

function normalizeCedula(value: string) {
  return value.replace(/\D/g, "").slice(0, 15);
}

function buildFavoriteLabel(items: SaleItem[], createdAt: string) {
  const shortDate = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(createdAt));
  const summary = items
    .slice(0, 2)
    .map((item) => item.name)
    .join(" + ");

  return summary
    ? `${summary}${items.length > 2 ? " y más" : ""} · ${shortDate}`
    : `Lista favorita · ${shortDate}`;
}

function formatFavoriteDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function useDeferredJsonStorage<T>(key: string, payload: T, delayMs: number) {
  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveJson(key, payload);
    }, delayMs);

    return () => {
      window.clearTimeout(handle);
    };
  }, [delayMs, key, payload]);
}
