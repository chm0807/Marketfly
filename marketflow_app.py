from pathlib import Path
import json
import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None


APP_BG = "#f2ede3"
CARD_BG = "#fffaf1"
CARD_ALT = "#f6efe4"
INK = "#201912"
MUTED = "#6c5d4e"
BRAND = "#cb5a1b"
BRAND_DARK = "#8f330c"
ACCENT = "#17654d"
LINE = "#d7c7b4"


class RegisterProductDialog(tk.Toplevel):
    def __init__(self, parent, barcode):
        super().__init__(parent)
        self.result = None
        self.configure(bg="#1d1611")
        self.title("Registrar producto")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()

        shell = tk.Frame(self, bg=CARD_BG, padx=24, pady=22)
        shell.pack(fill="both", expand=True, padx=1, pady=1)

        tk.Label(
            shell,
            text="REGISTRO RAPIDO",
            font=("Segoe UI Semibold", 9),
            fg=BRAND_DARK,
            bg=CARD_BG,
        ).pack(anchor="w")

        tk.Label(
            shell,
            text="Codigo no registrado",
            font=("Segoe UI Semibold", 18),
            fg=INK,
            bg=CARD_BG,
        ).pack(anchor="w", pady=(4, 8))

        tk.Label(
            shell,
            text="El escaner encontro un producto nuevo. Guardalo para seguir con la venta.",
            font=("Segoe UI", 10),
            fg=MUTED,
            bg=CARD_BG,
            wraplength=360,
            justify="left",
        ).pack(anchor="w")

        self.barcode_var = tk.StringVar(value=barcode)
        self.name_var = tk.StringVar()
        self.price_var = tk.StringVar()

        self._field(shell, "Codigo de barras", self.barcode_var, readonly=True)
        self._field(shell, "Nombre del producto", self.name_var)
        self._field(shell, "Precio unitario", self.price_var)

        buttons = tk.Frame(shell, bg=CARD_BG)
        buttons.pack(fill="x", pady=(18, 0))

        tk.Button(
            buttons,
            text="Cancelar",
            command=self.destroy,
            relief="flat",
            bd=0,
            bg="#efe4d7",
            fg=INK,
            activebackground="#e2d1bf",
            activeforeground=INK,
            padx=18,
            pady=10,
            font=("Segoe UI Semibold", 10),
        ).pack(side="right", padx=(10, 0))

        tk.Button(
            buttons,
            text="Guardar y agregar",
            command=self.submit,
            relief="flat",
            bd=0,
            bg=BRAND,
            fg="white",
            activebackground=BRAND_DARK,
            activeforeground="white",
            padx=18,
            pady=10,
            font=("Segoe UI Semibold", 10),
        ).pack(side="right")

        self.bind("<Return>", lambda event: self.submit())
        self.name_entry.focus_set()
        self.wait_visibility()
        self.geometry(self._center_geometry(parent, 430, 330))

    def _field(self, parent, label, variable, readonly=False):
        wrapper = tk.Frame(parent, bg=CARD_BG)
        wrapper.pack(fill="x", pady=(14, 0))

        tk.Label(
            wrapper,
            text=label,
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).pack(anchor="w", pady=(0, 6))

        state = "readonly" if readonly else "normal"
        entry = tk.Entry(
            wrapper,
            textvariable=variable,
            relief="flat",
            bd=0,
            highlightthickness=1,
            highlightbackground=LINE,
            highlightcolor=BRAND,
            bg="#fffdf8",
            fg=INK,
            insertbackground=INK,
            state=state,
            font=("Segoe UI", 11),
        )
        entry.pack(fill="x", ipady=10)

        if label == "Nombre del producto":
            self.name_entry = entry

    def submit(self):
        barcode = self.barcode_var.get().strip()
        name = self.name_var.get().strip()
        price_raw = self.price_var.get().strip().replace(",", ".")

        try:
            price = float(price_raw)
        except ValueError:
            price = -1

        if not barcode or not name or price < 0:
            messagebox.showerror(
                "Datos incompletos",
                "Completa nombre y precio valido antes de guardar.",
                parent=self,
            )
            return

        self.result = {
            "barcode": barcode,
            "name": name,
            "price": price,
        }
        self.destroy()

    def _center_geometry(self, parent, width, height):
        parent.update_idletasks()
        x = parent.winfo_rootx() + (parent.winfo_width() // 2) - (width // 2)
        y = parent.winfo_rooty() + (parent.winfo_height() // 2) - (height // 2)
        return f"{width}x{height}+{max(x, 20)}+{max(y, 20)}"


class MarketFlowApp:
    def __init__(self, root):
        self.root = root
        self.base_dir = Path(__file__).resolve().parent
        self.data_dir = self.base_dir / "data"
        self.catalog_path = self.data_dir / "catalog.json"
        self.sale_path = self.data_dir / "current_sale.json"
        self.settings_path = self.data_dir / "settings.json"
        self.data_dir.mkdir(exist_ok=True)

        self.catalog = self._load_json(self.catalog_path, {})
        self.sale_items = self._load_json(self.sale_path, {})
        self.settings = self._load_json(
            self.settings_path,
            {
                "tutorial_visible": True,
                "payment_method": "efectivo",
                "scanner_mode": "keyboard",
                "serial_port": "",
                "serial_baudrate": 9600,
            },
        )

        self.mode = "add"
        self.last_code = ""
        self.payment_method = self.settings.get("payment_method", "efectivo")
        self.payment_received_var = tk.StringVar(value="")
        self.scanner_buffer = ""
        self.last_input_at = 0.0
        self.tutorial_visible = self.settings.get("tutorial_visible", True)
        self.register_dialog = None
        self.scanner_mode_var = tk.StringVar(
            value=self.settings.get("scanner_mode", "keyboard")
        )
        self.serial_port_var = tk.StringVar(
            value=self.settings.get("serial_port", "")
        )
        self.serial_baudrate_var = tk.StringVar(
            value=str(self.settings.get("serial_baudrate", 9600))
        )
        self.serial_ports = []
        self.serial_queue = queue.Queue()
        self.serial_stop_event = None
        self.serial_thread = None
        self.serial_connected = False
        self.last_scan_source = "teclado"

        self.root.title("MarketFlow Pi")
        self.root.configure(bg=APP_BG)
        self.root.geometry("1480x900")
        self.root.minsize(1200, 760)

        self._build_styles()
        self._build_ui()
        self._bind_events()
        self.refresh_serial_ports()
        self.root.after(120, self._poll_serial_queue)
        self.render_all()
        self.announce("Sistema listo para escanear con el lector fisico.")

    def _build_styles(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure(
            "Invoice.Treeview",
            background="#fffdf8",
            fieldbackground="#fffdf8",
            foreground=INK,
            bordercolor=LINE,
            rowheight=38,
            font=("Segoe UI", 10),
        )
        style.configure(
            "Invoice.Treeview.Heading",
            background="#f2e7d8",
            foreground=INK,
            relief="flat",
            font=("Segoe UI Semibold", 10),
        )
        style.map("Invoice.Treeview", background=[("selected", "#f3d6c0")])

    def _build_ui(self):
        self.root.grid_columnconfigure(0, weight=1)
        self.root.grid_rowconfigure(1, weight=1)

        self.header = tk.Frame(self.root, bg=APP_BG, padx=24, pady=20)
        self.header.grid(row=0, column=0, sticky="ew")
        self.header.grid_columnconfigure(0, weight=1)

        title_box = tk.Frame(self.header, bg=APP_BG)
        title_box.grid(row=0, column=0, sticky="w")
        tk.Label(
            title_box,
            text="APLICATIVO DE CAJA PARA RASPBERRY PI 3",
            font=("Segoe UI Semibold", 10),
            fg=BRAND_DARK,
            bg=APP_BG,
        ).pack(anchor="w")
        tk.Label(
            title_box,
            text="MarketFlow Pi",
            font=("Segoe UI Semibold", 28),
            fg=INK,
            bg=APP_BG,
        ).pack(anchor="w", pady=(4, 2))
        tk.Label(
            title_box,
            text="Escaneo real, alta inmediata del producto y factura en vivo en una sola ventana.",
            font=("Segoe UI", 11),
            fg=MUTED,
            bg=APP_BG,
        ).pack(anchor="w")

        action_box = tk.Frame(self.header, bg=APP_BG)
        action_box.grid(row=0, column=1, sticky="e")
        self.tutorial_button = self._button(
            action_box, "Ocultar tutorial", self.toggle_tutorial, ghost=True
        )
        self.tutorial_button.pack(side="right", padx=(10, 0))
        self.new_sale_button = self._button(action_box, "Nueva venta", self.new_sale)
        self.new_sale_button.pack(side="right")

        self.content = tk.Frame(self.root, bg=APP_BG, padx=24, pady=0)
        self.content.grid(row=1, column=0, sticky="nsew")
        self.content.grid_columnconfigure(0, weight=3)
        self.content.grid_columnconfigure(1, weight=2)
        self.content.grid_rowconfigure(0, weight=1)

        self.left_column = tk.Frame(self.content, bg=APP_BG)
        self.left_column.grid(row=0, column=0, sticky="nsew", padx=(0, 12))
        self.left_column.grid_rowconfigure(1, weight=1)
        self.left_column.grid_columnconfigure(0, weight=1)

        self.right_column = tk.Frame(self.content, bg=APP_BG)
        self.right_column.grid(row=0, column=1, sticky="nsew", padx=(12, 0))
        self.right_column.grid_rowconfigure(1, weight=1)
        self.right_column.grid_columnconfigure(0, weight=1)

        self._build_scanner_card()
        self._build_invoice_card()
        self._build_tutorial_card()
        self._build_payment_card()

    def _build_scanner_card(self):
        self.scanner_card = self._card(self.left_column)
        self.scanner_card.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        self.scanner_card.grid_columnconfigure(0, weight=1)

        top = tk.Frame(self.scanner_card, bg=CARD_BG)
        top.grid(row=0, column=0, sticky="ew")
        top.grid_columnconfigure(0, weight=1)

        self._card_title(top, "LECTOR", "Estado del escaneo").grid(
            row=0, column=0, sticky="w"
        )

        mode_box = tk.Frame(top, bg=CARD_ALT, padx=6, pady=6)
        mode_box.grid(row=0, column=1, sticky="e")
        self.add_mode_button = self._mode_button(
            mode_box, "Agregar", lambda: self.set_mode("add")
        )
        self.add_mode_button.pack(side="left", padx=(0, 6))
        self.remove_mode_button = self._mode_button(
            mode_box, "Eliminar", lambda: self.set_mode("remove")
        )
        self.remove_mode_button.pack(side="left")

        stats = tk.Frame(self.scanner_card, bg=CARD_BG)
        stats.grid(row=1, column=0, sticky="ew", pady=(18, 0))
        for column in range(2):
            stats.grid_columnconfigure(column, weight=1)

        self.mode_value = self._stat_card(stats, 0, 0, "Modo actual", "Agregar productos")
        self.last_code_value = self._stat_card(
            stats, 0, 1, "Ultimo codigo", "Sin lectura todavia"
        )
        self.catalog_value = self._stat_card(stats, 1, 0, "Catalogo", "0 productos")
        self.scan_message_value = self._stat_card(
            stats, 1, 1, "Mensaje del sistema", "Esperando lectura del lector..."
        )

        hint = tk.Label(
            self.scanner_card,
            text=(
                "El lector debe funcionar como teclado y finalizar el codigo con Enter o Tab. "
                "En modo Eliminar, volver a escanear resta una unidad del producto."
            ),
            bg=CARD_BG,
            fg=MUTED,
            font=("Segoe UI", 10),
            justify="left",
            wraplength=760,
        )
        hint.grid(row=2, column=0, sticky="w", pady=(18, 0))

        scanner_io = tk.Frame(self.scanner_card, bg=CARD_BG)
        scanner_io.grid(row=3, column=0, sticky="ew", pady=(18, 0))
        scanner_io.grid_columnconfigure(1, weight=1)

        tk.Label(
            scanner_io,
            text="Interfaz del lector",
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).grid(row=0, column=0, sticky="w")

        mode_picker = tk.Frame(scanner_io, bg=CARD_BG)
        mode_picker.grid(row=0, column=1, sticky="w")
        for value, text in (("keyboard", "Teclado HID"), ("serial", "Serial USB")):
            radio = tk.Radiobutton(
                mode_picker,
                text=text,
                variable=self.scanner_mode_var,
                value=value,
                command=self.on_scanner_mode_change,
                bg=CARD_BG,
                fg=INK,
                selectcolor=CARD_BG,
                activebackground=CARD_BG,
                activeforeground=INK,
                font=("Segoe UI", 10),
            )
            radio.pack(side="left", padx=(0, 14))

        tk.Label(
            scanner_io,
            text="Puerto serial",
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).grid(row=1, column=0, sticky="w", pady=(12, 0))

        port_row = tk.Frame(scanner_io, bg=CARD_BG)
        port_row.grid(row=1, column=1, sticky="ew", pady=(12, 0))
        port_row.grid_columnconfigure(0, weight=1)

        self.port_combo = ttk.Combobox(
            port_row,
            textvariable=self.serial_port_var,
            state="readonly",
            values=[],
        )
        self.port_combo.grid(row=0, column=0, sticky="ew")

        self.refresh_ports_button = self._button(
            port_row, "Actualizar", self.refresh_serial_ports, ghost=True, small=True
        )
        self.refresh_ports_button.grid(row=0, column=1, padx=(8, 0))

        tk.Label(
            scanner_io,
            text="Baudrate",
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).grid(row=2, column=0, sticky="w", pady=(12, 0))

        baud_row = tk.Frame(scanner_io, bg=CARD_BG)
        baud_row.grid(row=2, column=1, sticky="w", pady=(12, 0))

        self.baudrate_entry = tk.Entry(
            baud_row,
            textvariable=self.serial_baudrate_var,
            relief="flat",
            bd=0,
            bg="#fffdf8",
            fg=INK,
            highlightthickness=1,
            highlightbackground=LINE,
            highlightcolor=BRAND,
            insertbackground=INK,
            font=("Segoe UI", 10),
            width=14,
        )
        self.baudrate_entry.pack(side="left", ipady=8)

        self.connect_serial_button = self._button(
            baud_row, "Conectar lector", self.connect_serial_scanner, small=True
        )
        self.connect_serial_button.pack(side="left", padx=(8, 0))

        self.disconnect_serial_button = self._button(
            baud_row, "Desconectar", self.disconnect_serial_scanner, ghost=True, small=True
        )
        self.disconnect_serial_button.pack(side="left", padx=(8, 0))

        self.scanner_connection_value = self._inline_info(
            scanner_io, 3, "Conexion", "Modo teclado listo"
        )
        self.scan_source_value = self._inline_info(
            scanner_io, 4, "Origen ultimo escaneo", "teclado"
        )

    def _build_invoice_card(self):
        self.invoice_card = self._card(self.left_column)
        self.invoice_card.grid(row=1, column=0, sticky="nsew")
        self.invoice_card.grid_rowconfigure(1, weight=1)
        self.invoice_card.grid_columnconfigure(0, weight=1)

        top = tk.Frame(self.invoice_card, bg=CARD_BG)
        top.grid(row=0, column=0, sticky="ew")
        top.grid_columnconfigure(0, weight=1)

        self._card_title(top, "FACTURACION", "Venta actual").grid(
            row=0, column=0, sticky="w"
        )

        badge_box = tk.Frame(top, bg=CARD_BG)
        badge_box.grid(row=0, column=1, sticky="e")
        self.item_badge = self._badge(badge_box, "0 items")
        self.item_badge.pack(side="left", padx=(0, 8))
        self.total_badge = self._badge(badge_box, "$ 0", accent=True)
        self.total_badge.pack(side="left")

        table_shell = tk.Frame(self.invoice_card, bg="#f0e5d7", padx=1, pady=1)
        table_shell.grid(row=1, column=0, sticky="nsew", pady=(18, 0))
        table_shell.grid_rowconfigure(0, weight=1)
        table_shell.grid_columnconfigure(0, weight=1)

        self.invoice_tree = ttk.Treeview(
            table_shell,
            columns=("barcode", "name", "quantity", "price", "total"),
            show="headings",
            style="Invoice.Treeview",
            selectmode="browse",
        )
        self.invoice_tree.grid(row=0, column=0, sticky="nsew")

        headings = {
            "barcode": "Codigo",
            "name": "Producto",
            "quantity": "Cantidad",
            "price": "Precio",
            "total": "Total",
        }
        widths = {"barcode": 160, "name": 280, "quantity": 90, "price": 120, "total": 120}
        anchors = {"barcode": "w", "name": "w", "quantity": "center", "price": "e", "total": "e"}

        for key, text in headings.items():
            self.invoice_tree.heading(key, text=text)
            self.invoice_tree.column(key, width=widths[key], anchor=anchors[key], stretch=True)

        scrollbar = ttk.Scrollbar(
            table_shell, orient="vertical", command=self.invoice_tree.yview
        )
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.invoice_tree.configure(yscrollcommand=scrollbar.set)

        actions = tk.Frame(self.invoice_card, bg=CARD_BG)
        actions.grid(row=2, column=0, sticky="ew", pady=(16, 0))
        self.add_selected_button = self._button(
            actions, "Agregar unidad seleccionada", self.add_selected_item, small=True
        )
        self.add_selected_button.pack(side="left")
        self.remove_selected_button = self._button(
            actions, "Quitar unidad seleccionada", self.remove_selected_item, ghost=True, small=True
        )
        self.remove_selected_button.pack(side="left", padx=(10, 0))

        summary = tk.Frame(self.invoice_card, bg=CARD_BG)
        summary.grid(row=3, column=0, sticky="ew", pady=(16, 0))
        for column in range(3):
            summary.grid_columnconfigure(column, weight=1)

        self.subtotal_value = self._mini_summary(summary, 0, "Subtotal", "$ 0")
        self.distinct_value = self._mini_summary(summary, 1, "Productos distintos", "0")
        self.units_value = self._mini_summary(summary, 2, "Unidades acumuladas", "0")

    def _build_tutorial_card(self):
        self.tutorial_card = self._card(self.right_column)
        self.tutorial_card.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        self.tutorial_card.grid_columnconfigure(0, weight=1)

        top = tk.Frame(self.tutorial_card, bg=CARD_BG)
        top.grid(row=0, column=0, sticky="ew")
        top.grid_columnconfigure(0, weight=1)

        self._card_title(top, "TUTORIAL", "Guia del cajero").grid(
            row=0, column=0, sticky="w"
        )

        self.tutorial_steps_box = tk.Frame(self.tutorial_card, bg=CARD_BG)
        self.tutorial_steps_box.grid(row=1, column=0, sticky="ew", pady=(16, 0))

        steps = [
            "Conecta el lector a la Raspberry Pi y abre el aplicativo en pantalla completa.",
            "Escanea un producto. Si no existe, el sistema abrira el registro rapido.",
            "Cada lectura suma una unidad y actualiza la factura al instante.",
            "Para quitar un producto, cambia a Eliminar y vuelve a escanear ese codigo.",
            "Revisa total, metodo de pago y confirma el cobro para cerrar la venta.",
        ]
        for index, step in enumerate(steps, start=1):
            step_card = tk.Frame(
                self.tutorial_steps_box,
                bg=CARD_ALT,
                highlightthickness=1,
                highlightbackground="#e4d8ca",
                padx=14,
                pady=14,
            )
            step_card.pack(fill="x", pady=(0, 10))
            tk.Label(
                step_card,
                text=f"Paso {index}",
                font=("Segoe UI Semibold", 10),
                fg=BRAND_DARK,
                bg=CARD_ALT,
            ).pack(anchor="w")
            tk.Label(
                step_card,
                text=step,
                font=("Segoe UI", 10),
                fg=INK,
                bg=CARD_ALT,
                justify="left",
                wraplength=420,
            ).pack(anchor="w", pady=(4, 0))

    def _build_payment_card(self):
        self.payment_card = self._card(self.right_column)
        self.payment_card.grid(row=1, column=0, sticky="nsew")
        self.payment_card.grid_columnconfigure(0, weight=1)

        self._card_title(self.payment_card, "COBRO", "Proceso de pago").grid(
            row=0, column=0, sticky="w"
        )

        self.payment_prompt = tk.Label(
            self.payment_card,
            text="No hay productos cargados todavia.",
            bg=CARD_BG,
            fg=MUTED,
            font=("Segoe UI", 10),
            justify="left",
            wraplength=440,
        )
        self.payment_prompt.grid(row=1, column=0, sticky="w", pady=(14, 0))

        method_box = tk.Frame(self.payment_card, bg=CARD_BG)
        method_box.grid(row=2, column=0, sticky="ew", pady=(18, 0))

        tk.Label(
            method_box,
            text="Metodo de pago",
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).pack(anchor="w")

        self.payment_method_var = tk.StringVar(value=self.payment_method)
        chooser = tk.Frame(method_box, bg=CARD_BG)
        chooser.pack(anchor="w", pady=(8, 0))
        for value, text in (
            ("efectivo", "Efectivo"),
            ("tarjeta", "Tarjeta"),
            ("transferencia", "Transferencia"),
        ):
            radio = tk.Radiobutton(
                chooser,
                text=text,
                variable=self.payment_method_var,
                value=value,
                command=self.on_payment_method_change,
                bg=CARD_BG,
                fg=INK,
                selectcolor=CARD_BG,
                activebackground=CARD_BG,
                activeforeground=INK,
                font=("Segoe UI", 10),
            )
            radio.pack(side="left", padx=(0, 16))

        amount_box = tk.Frame(self.payment_card, bg=CARD_BG)
        amount_box.grid(row=3, column=0, sticky="ew", pady=(18, 0))
        tk.Label(
            amount_box,
            text="Monto recibido",
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).pack(anchor="w")
        self.payment_entry = tk.Entry(
            amount_box,
            textvariable=self.payment_received_var,
            relief="flat",
            bd=0,
            bg="#fffdf8",
            fg=INK,
            highlightthickness=1,
            highlightbackground=LINE,
            highlightcolor=BRAND,
            insertbackground=INK,
            font=("Segoe UI", 12),
        )
        self.payment_entry.pack(fill="x", ipady=10, pady=(8, 0))
        self.payment_entry.bind("<KeyRelease>", lambda event: self.render_payment())

        totals = tk.Frame(self.payment_card, bg=CARD_BG)
        totals.grid(row=4, column=0, sticky="ew", pady=(18, 0))
        for column in range(3):
            totals.grid_columnconfigure(column, weight=1)

        self.payment_total_value = self._mini_summary(totals, 0, "Total a cobrar", "$ 0")
        self.payment_due_value = self._mini_summary(totals, 1, "Saldo pendiente", "$ 0")
        self.payment_change_value = self._mini_summary(totals, 2, "Cambio", "$ 0")

        self.complete_button = self._button(
            self.payment_card,
            "Confirmar pago y cerrar venta",
            self.complete_sale,
            full=True,
        )
        self.complete_button.grid(row=5, column=0, sticky="ew", pady=(18, 0))

    def _bind_events(self):
        self.root.bind_all("<Key>", self.handle_keypress, add="+")
        self.root.bind("<F11>", self.toggle_fullscreen)
        self.root.bind("<Escape>", self.exit_fullscreen)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _card(self, parent):
        card = tk.Frame(
            parent,
            bg=CARD_BG,
            highlightthickness=1,
            highlightbackground=LINE,
            padx=22,
            pady=22,
        )
        return card

    def _card_title(self, parent, tag, title):
        box = tk.Frame(parent, bg=parent["bg"])
        tk.Label(
            box,
            text=tag,
            font=("Segoe UI Semibold", 9),
            fg=BRAND_DARK,
            bg=parent["bg"],
        ).pack(anchor="w")
        tk.Label(
            box,
            text=title,
            font=("Segoe UI Semibold", 20),
            fg=INK,
            bg=parent["bg"],
        ).pack(anchor="w", pady=(4, 0))
        return box

    def _button(self, parent, text, command, ghost=False, small=False, full=False):
        bg = "#ece1d4" if ghost else BRAND
        fg = INK if ghost else "white"
        active_bg = "#dfd0bf" if ghost else BRAND_DARK
        button = tk.Button(
            parent,
            text=text,
            command=command,
            relief="flat",
            bd=0,
            bg=bg,
            fg=fg,
            activebackground=active_bg,
            activeforeground=fg,
            cursor="hand2",
            padx=16 if small else 18,
            pady=9 if small else 12,
            font=("Segoe UI Semibold", 10),
        )
        if full:
            button.configure(anchor="center")
        return button

    def _mode_button(self, parent, text, command):
        return tk.Button(
            parent,
            text=text,
            command=command,
            relief="flat",
            bd=0,
            cursor="hand2",
            padx=18,
            pady=9,
            font=("Segoe UI Semibold", 10),
        )

    def _badge(self, parent, text, accent=False):
        bg = "#dcefe8" if accent else "#f1e6d8"
        fg = ACCENT if accent else INK
        return tk.Label(
            parent,
            text=text,
            bg=bg,
            fg=fg,
            padx=12,
            pady=8,
            font=("Segoe UI Semibold", 10),
        )

    def _stat_card(self, parent, row, column, title, value):
        card = tk.Frame(
            parent,
            bg=CARD_ALT,
            highlightthickness=1,
            highlightbackground="#e4d8ca",
            padx=14,
            pady=14,
        )
        card.grid(row=row, column=column, sticky="nsew", padx=(0, 12 if column == 0 else 0), pady=(0, 12 if row == 0 else 0))

        tk.Label(
            card,
            text=title,
            font=("Segoe UI Semibold", 9),
            fg=MUTED,
            bg=CARD_ALT,
        ).pack(anchor="w")

        label = tk.Label(
            card,
            text=value,
            font=("Segoe UI Semibold", 13),
            fg=INK,
            bg=CARD_ALT,
            justify="left",
            wraplength=320,
        )
        label.pack(anchor="w", pady=(5, 0))
        return label

    def _mini_summary(self, parent, column, title, value):
        card = tk.Frame(
            parent,
            bg=CARD_ALT,
            highlightthickness=1,
            highlightbackground="#e4d8ca",
            padx=14,
            pady=14,
        )
        card.grid(row=0, column=column, sticky="ew", padx=(0, 10 if column < 2 else 0))
        tk.Label(
            card,
            text=title,
            font=("Segoe UI Semibold", 9),
            fg=MUTED,
            bg=CARD_ALT,
        ).pack(anchor="w")
        label = tk.Label(
            card,
            text=value,
            font=("Segoe UI Semibold", 15),
            fg=INK,
            bg=CARD_ALT,
        )
        label.pack(anchor="w", pady=(5, 0))
        return label

    def _inline_info(self, parent, row, title, value):
        tk.Label(
            parent,
            text=title,
            font=("Segoe UI Semibold", 10),
            fg=INK,
            bg=CARD_BG,
        ).grid(row=row, column=0, sticky="w", pady=(12, 0))
        label = tk.Label(
            parent,
            text=value,
            font=("Segoe UI", 10),
            fg=MUTED,
            bg=CARD_BG,
            justify="left",
            wraplength=520,
        )
        label.grid(row=row, column=1, sticky="w", pady=(12, 0))
        return label

    def toggle_tutorial(self):
        self.tutorial_visible = not self.tutorial_visible
        self._save_settings()
        self.render_tutorial()

    def toggle_fullscreen(self, event=None):
        current = bool(self.root.attributes("-fullscreen"))
        self.root.attributes("-fullscreen", not current)

    def exit_fullscreen(self, event=None):
        self.root.attributes("-fullscreen", False)

    def handle_keypress(self, event):
        if self.scanner_mode_var.get() != "keyboard":
            return

        if self.register_dialog is not None and self.register_dialog.winfo_exists():
            return

        key = event.keysym
        char = event.char
        now = time.monotonic()
        gap = now - self.last_input_at

        if char and char.isprintable() and (char.isalnum() or char == "-"):
            if gap > 0.08:
                self.scanner_buffer = ""
            self.scanner_buffer += char
            self.last_input_at = now
            return

        if key in ("Return", "Tab"):
            if len(self.scanner_buffer) >= 6:
                barcode = self.scanner_buffer
                self.scanner_buffer = ""
                self.process_barcode(barcode)
            return

        if gap > 0.08:
            self.scanner_buffer = ""

    def process_barcode(self, barcode, source="keyboard"):
        barcode = str(barcode).strip()
        if not barcode:
            return

        self.last_code = barcode
        self.last_scan_source = "teclado" if source == "keyboard" else "serial"
        self.last_code_value.config(text=barcode)
        self.scan_source_value.config(text=self.last_scan_source)

        if self.mode == "remove":
            if not self.remove_product(barcode):
                self.announce("Ese codigo no esta en la venta actual para quitarlo.")
            return

        product = self.catalog.get(barcode)
        if product is None:
            self.open_register_dialog(barcode)
            return

        self.add_product(product)
        self.announce(f'Producto "{product["name"]}" agregado correctamente.')

    def open_register_dialog(self, barcode):
        self.announce("Codigo nuevo detectado. Completa el registro para continuar.")
        self.register_dialog = RegisterProductDialog(self.root, barcode)
        self.root.wait_window(self.register_dialog)

        if self.register_dialog.result:
            product = self.register_dialog.result
            self.catalog[barcode] = product
            self._save_json(self.catalog_path, self.catalog)
            self.add_product(product)
            self.announce("Producto registrado y agregado a la factura.")
        else:
            self.announce("Registro cancelado. El codigo no se agrego a la venta.")

        self.register_dialog = None
        self.render_all()

    def add_product(self, product):
        barcode = product["barcode"]
        current = self.sale_items.get(barcode)
        if current is None:
            self.sale_items[barcode] = {
                "barcode": barcode,
                "name": product["name"],
                "price": product["price"],
                "quantity": 1,
            }
        else:
            current["quantity"] += 1
        self._save_json(self.sale_path, self.sale_items)
        self.render_all()

    def remove_product(self, barcode):
        item = self.sale_items.get(barcode)
        if item is None:
            return False

        item["quantity"] -= 1
        if item["quantity"] <= 0:
            del self.sale_items[barcode]

        self._save_json(self.sale_path, self.sale_items)
        self.render_all()
        self.announce("Producto retirado de la factura actual.")
        return True

    def add_selected_item(self):
        barcode = self._selected_barcode()
        if barcode and barcode in self.catalog:
            self.add_product(self.catalog[barcode])

    def remove_selected_item(self):
        barcode = self._selected_barcode()
        if barcode:
            self.remove_product(barcode)

    def _selected_barcode(self):
        selection = self.invoice_tree.selection()
        if not selection:
            self.announce("Selecciona un producto de la factura primero.")
            return None
        return selection[0]

    def on_scanner_mode_change(self):
        mode = self.scanner_mode_var.get()
        if mode == "keyboard":
            self.disconnect_serial_scanner(silent=True)
            self.announce("Interfaz de lectura cambiada a teclado HID.")
        else:
            self.announce("Interfaz de lectura cambiada a serial USB. Conecta el puerto.")
        self._save_settings()
        self.render_scanner_interface()

    def refresh_serial_ports(self):
        ports = []
        if list_ports is not None:
            try:
                ports = [item.device for item in list_ports.comports()]
            except Exception:
                ports = []

        self.serial_ports = ports
        self.port_combo["values"] = ports

        if self.serial_port_var.get() not in ports:
            self.serial_port_var.set(ports[0] if ports else "")

        self.render_scanner_interface()

    def connect_serial_scanner(self):
        if serial is None:
            self.announce("PySerial no esta instalado. Instala python3-serial en la Raspberry Pi.")
            self.render_scanner_interface()
            return

        port = self.serial_port_var.get().strip()
        if not port:
            self.announce("Selecciona un puerto serial antes de conectar el lector.")
            return

        try:
            baudrate = int(self.serial_baudrate_var.get().strip())
        except ValueError:
            self.announce("El baudrate no es valido. Usa un numero como 9600.")
            return

        self.disconnect_serial_scanner(silent=True)

        self.serial_stop_event = threading.Event()
        self.serial_thread = threading.Thread(
            target=self._serial_loop,
            args=(port, baudrate, self.serial_stop_event),
            daemon=True,
        )
        self.serial_thread.start()
        self.scanner_mode_var.set("serial")
        self._save_settings()
        self.announce(f"Intentando conectar el lector serial en {port}...")
        self.render_scanner_interface()

    def disconnect_serial_scanner(self, silent=False):
        if self.serial_stop_event is not None:
            self.serial_stop_event.set()
            self.serial_stop_event = None
        self.serial_connected = False
        self.serial_thread = None
        if not silent:
            self.announce("Lector serial desconectado.")
        self.render_scanner_interface()

    def _serial_loop(self, port, baudrate, stop_event):
        connection = None
        buffer = ""
        try:
            connection = serial.Serial(port=port, baudrate=baudrate, timeout=0.2)
            self.serial_queue.put(("connected", port))

            while not stop_event.is_set():
                chunk = connection.read(connection.in_waiting or 1)
                if not chunk:
                    continue

                text = chunk.decode("utf-8", errors="ignore")
                for char in text:
                    if char in "\r\n\t":
                        if len(buffer.strip()) >= 6:
                            self.serial_queue.put(("scan", buffer.strip()))
                        buffer = ""
                    elif char.isprintable():
                        buffer += char
        except Exception as error:
            self.serial_queue.put(("error", str(error)))
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            self.serial_queue.put(("disconnected", port))

    def _poll_serial_queue(self):
        while True:
            try:
                event = self.serial_queue.get_nowait()
            except queue.Empty:
                break

            kind = event[0]
            if kind == "connected":
                self.serial_connected = True
                self.serial_port_var.set(event[1])
                self.announce(f"Lector serial conectado en {event[1]}.")
                self.render_scanner_interface()
            elif kind == "scan":
                self.process_barcode(event[1], source="serial")
            elif kind == "error":
                self.serial_connected = False
                self.announce(f"Error en lector serial: {event[1]}")
                self.render_scanner_interface()
            elif kind == "disconnected":
                self.serial_connected = False
                self.render_scanner_interface()

        self.root.after(120, self._poll_serial_queue)

    def set_mode(self, mode):
        self.mode = mode
        self.render_mode()
        if mode == "add":
            self.announce("Modo agregar activo. El siguiente escaneo suma productos.")
        else:
            self.announce("Modo eliminar activo. El siguiente escaneo resta productos.")

    def new_sale(self):
        if not self.sale_items:
            self.announce("No hay productos en la venta actual.")
            return

        confirmed = messagebox.askyesno(
            "Nueva venta",
            "Se limpiara la factura actual y el catalogo seguira guardado. Continuar?",
            parent=self.root,
        )
        if not confirmed:
            return

        self.sale_items = {}
        self.payment_received_var.set("")
        self._save_json(self.sale_path, self.sale_items)
        self.render_all()
        self.announce("Venta reiniciada. Lista para un nuevo cliente.")

    def complete_sale(self):
        totals = self.calculate_totals()
        received = self._payment_received()
        due = max(totals["total"] - received, 0)

        if totals["units"] == 0:
            self.announce("No hay productos para cerrar en esta venta.")
            return

        if self.payment_method_var.get() == "efectivo" and due > 0:
            self.announce("El pago en efectivo aun esta incompleto.")
            return

        confirmed = messagebox.askyesno(
            "Cerrar venta",
            "Se confirmara el cobro y se limpiara la factura actual. Deseas continuar?",
            parent=self.root,
        )
        if not confirmed:
            return

        self.sale_items = {}
        self.payment_received_var.set("")
        self._save_json(self.sale_path, self.sale_items)
        self.render_all()
        self.announce("Venta cerrada correctamente. Lista para el siguiente cliente.")

    def on_payment_method_change(self):
        self.payment_method = self.payment_method_var.get()
        self._save_settings()
        self.render_payment()

    def render_all(self):
        self.render_mode()
        self.render_tutorial()
        self.render_catalog()
        self.render_scanner_interface()
        self.render_invoice()
        self.render_payment()

    def render_mode(self):
        active_bg = BRAND
        inactive_bg = "#e9ddcf"
        active_fg = "white"
        inactive_fg = INK

        self.add_mode_button.configure(
            bg=active_bg if self.mode == "add" else inactive_bg,
            fg=active_fg if self.mode == "add" else inactive_fg,
            activebackground=BRAND_DARK if self.mode == "add" else "#d8c5b1",
            activeforeground=active_fg if self.mode == "add" else inactive_fg,
        )
        self.remove_mode_button.configure(
            bg=active_bg if self.mode == "remove" else inactive_bg,
            fg=active_fg if self.mode == "remove" else inactive_fg,
            activebackground=BRAND_DARK if self.mode == "remove" else "#d8c5b1",
            activeforeground=active_fg if self.mode == "remove" else inactive_fg,
        )
        self.mode_value.config(
            text="Agregar productos" if self.mode == "add" else "Eliminar productos"
        )

    def render_tutorial(self):
        if self.tutorial_visible:
            self.tutorial_card.grid()
            self.tutorial_button.configure(text="Ocultar tutorial")
        else:
            self.tutorial_card.grid_remove()
            self.tutorial_button.configure(text="Ver tutorial")

    def render_catalog(self):
        count = len(self.catalog)
        suffix = "producto" if count == 1 else "productos"
        self.catalog_value.config(text=f"{count} {suffix}")
        if self.last_code:
            self.last_code_value.config(text=self.last_code)

    def render_scanner_interface(self):
        mode = self.scanner_mode_var.get()
        serial_enabled = mode == "serial"
        serial_available = serial is not None

        if serial_enabled:
            self.port_combo.configure(state="readonly" if serial_available else "disabled")
            self.baudrate_entry.configure(state="normal" if serial_available else "disabled")
            self.connect_serial_button.configure(
                state="normal" if serial_available and not self.serial_connected else "disabled"
            )
            self.disconnect_serial_button.configure(
                state="normal" if self.serial_connected else "disabled"
            )
            if not serial_available:
                connection_text = "PySerial no disponible. Instala python3-serial."
            elif self.serial_connected:
                connection_text = f"Conectado en {self.serial_port_var.get() or 'puerto serial'}"
            else:
                connection_text = "Serial listo para conectar."
        else:
            self.port_combo.configure(state="disabled")
            self.baudrate_entry.configure(state="disabled")
            self.connect_serial_button.configure(state="disabled")
            self.disconnect_serial_button.configure(state="disabled")
            connection_text = "Modo teclado HID listo para capturar lecturas."

        self.scanner_connection_value.config(text=connection_text)
        self.scan_source_value.config(text=self.last_scan_source)

    def render_invoice(self):
        for item_id in self.invoice_tree.get_children():
            self.invoice_tree.delete(item_id)

        totals = self.calculate_totals()
        ordered_items = sorted(self.sale_items.values(), key=lambda item: item["name"].lower())
        for item in ordered_items:
            self.invoice_tree.insert(
                "",
                "end",
                iid=item["barcode"],
                values=(
                    item["barcode"],
                    item["name"],
                    item["quantity"],
                    self.format_currency(item["price"]),
                    self.format_currency(item["price"] * item["quantity"]),
                ),
            )

        item_text = "item" if totals["units"] == 1 else "items"
        self.item_badge.config(text=f'{totals["units"]} {item_text}')
        self.total_badge.config(text=self.format_currency(totals["total"]))
        self.subtotal_value.config(text=self.format_currency(totals["total"]))
        self.distinct_value.config(text=str(totals["distinct"]))
        self.units_value.config(text=str(totals["units"]))

    def render_payment(self):
        totals = self.calculate_totals()
        received = self._payment_received()
        due = max(totals["total"] - received, 0)
        change = max(received - totals["total"], 0)

        self.payment_total_value.config(text=self.format_currency(totals["total"]))
        self.payment_due_value.config(text=self.format_currency(due))
        self.payment_change_value.config(text=self.format_currency(change))

        if totals["units"] == 0:
            self.complete_button.configure(state="disabled")
            self.payment_prompt.config(
                text="No hay productos cargados. El sistema preguntara por el pago cuando inicie una venta."
            )
            return

        self.complete_button.configure(state="normal")
        method = self.payment_method_var.get()
        self.payment_method = method

        if method == "efectivo":
            if received <= 0:
                self.payment_prompt.config(
                    text=(
                        f'Llevas {totals["units"]} productos por {self.format_currency(totals["total"])}. '
                        "Ingresa cuanto entrega el cliente."
                    )
                )
                return
            if received < totals["total"]:
                self.payment_prompt.config(
                    text=f"Pago parcial recibido. Faltan {self.format_currency(due)}."
                )
                return
            self.payment_prompt.config(
                text=f"Pago completo en efectivo. Debes entregar {self.format_currency(change)} de cambio."
            )
            return

        if method == "tarjeta":
            self.payment_prompt.config(
                text=(
                    f'Cobro con tarjeta por {self.format_currency(totals["total"])}. '
                    "Verifica aprobacion del datafono antes de cerrar."
                )
            )
            return

        self.payment_prompt.config(
            text=(
                f'Transferencia seleccionada por {self.format_currency(totals["total"])}. '
                "Confirma el comprobante antes de terminar la venta."
            )
        )

    def calculate_totals(self):
        total = 0
        units = 0
        distinct = 0
        for item in self.sale_items.values():
            total += item["price"] * item["quantity"]
            units += item["quantity"]
            distinct += 1
        return {"total": total, "units": units, "distinct": distinct}

    def _payment_received(self):
        raw = self.payment_received_var.get().strip().replace(",", ".")
        if not raw:
            return 0.0
        try:
            return float(raw)
        except ValueError:
            return 0.0

    def announce(self, message):
        self.scan_message_value.config(text=message)

    def format_currency(self, value):
        amount = int(round(float(value)))
        formatted = f"{amount:,}".replace(",", ".")
        return f"$ {formatted}"

    def _save_settings(self):
        self._save_json(
            self.settings_path,
            {
                "tutorial_visible": self.tutorial_visible,
                "payment_method": self.payment_method_var.get(),
                "scanner_mode": self.scanner_mode_var.get(),
                "serial_port": self.serial_port_var.get(),
                "serial_baudrate": self.serial_baudrate_var.get(),
            },
        )

    def _load_json(self, path, fallback):
        if not path.exists():
            return fallback
        try:
            with path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except (json.JSONDecodeError, OSError):
            return fallback

    def _save_json(self, path, payload):
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

    def on_close(self):
        self.disconnect_serial_scanner(silent=True)
        self.root.destroy()


def main():
    root = tk.Tk()
    app = MarketFlowApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
