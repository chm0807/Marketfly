export type ScannerSource = "keyboard" | "serial";
export type ReaderMode = "add" | "remove";
export type PaymentMethod = "tarjeta" | "qr_banco" | "nequi";

export interface Product {
  barcode: string;
  name: string;
  price: number;
}

export interface SaleItem extends Product {
  quantity: number;
}

export interface SerialConfig {
  port: string;
  baudrate: number;
}

export interface ScannerStatusEvent {
  connected: boolean;
  mode: "serial";
  port: string | null;
  message: string;
}

export interface ScannerScanEvent {
  code: string;
  source: ScannerSource;
}
