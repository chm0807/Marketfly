# MarketFlow Pi

Aplicativo de escritorio con `Tauri + React + TypeScript` para caja de
supermercado con lector fisico de codigo de barras.

## Estructura principal

- `src/`: interfaz React + TypeScript.
- `src-tauri/`: shell nativo en Rust para Tauri.
- `src/App.tsx`: flujo principal de caja, lector, factura y pago.
- `src-tauri/src/main.rs`: comandos nativos para puertos seriales y eventos de escaneo.

## Que hace

- Interfaz de caja tipo POS, mas visual y clara que el prototipo anterior.
- Soporte para lector `Teclado HID` y `Serial USB`.
- Alta rapida de productos nuevos dentro del flujo de venta.
- Factura en vivo, eliminacion de productos, totales y cierre de venta.
- Persistencia local del catalogo, venta actual y preferencias.

## Requisitos para Raspberry Pi

1. Node.js 20 o superior.
2. Rust y Cargo.
3. Dependencias de Tauri para Linux.

Ejemplo base en Raspberry Pi OS:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
curl https://sh.rustup.rs -sSf | sh
```

## Instalar dependencias del proyecto

```bash
npm install
```

## Ejecutar en desarrollo

```bash
npm run tauri dev
```

## Compilar

```bash
npm run tauri build
```

## Flujo de uso

1. Abre la app.
2. Elige si el lector trabaja como `Teclado HID` o `Serial USB`.
3. Si es serial, selecciona el puerto, revisa el baudrate y conecta el lector.
4. Escanea productos.
5. Si un codigo no existe, registra nombre y precio en la ventana emergente.
6. Cobra y cierra la venta.

## Persistencia

La app guarda informacion en `localStorage` del frontend:

- catalogo
- venta actual
- configuracion del lector
- preferencias de interfaz

## Nota

En este entorno no habia `cargo`, asi que pude dejar el proyecto Tauri armado y
coherente, pero no compilarlo aqui. Antes de correrlo en Raspberry Pi necesitas
instalar Rust/Cargo y ejecutar `npm install`.
