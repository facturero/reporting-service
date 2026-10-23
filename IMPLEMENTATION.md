# IMPLEMENTATION.md — reporting-service (anexos del SRI, Fase 6.1)

Puerto **3019**, base `reporting_db`, rama `main`, módulo de catálogo `compliance.sri_annexes`. Escrito el 2026-10-23.
Solo dice lo que se verificó. Lo que no existe o no se pudo comprobar está en §7 «Límites».

## 1. Qué hace

Prepara, a partir de los comprobantes del ERP, tres anexos tributarios del SRI **como borrador para el contador** (el sistema no presenta nada al SRI):

| Anexo | Qué entrega | Formato hoy |
|---|---|---|
| **Formulario 104** (IVA) | ventas y compras por tarifa (netas de notas de crédito), crédito tributario, **liquidación** del mes y el IVA retenido a proveedores | pantalla + CSV |
| **Formulario 103** (renta) | retenciones de renta practicadas, por **código de concepto** | pantalla + CSV |
| **ATS** | compras con sus retenciones, ventas por cliente y tipo de comprobante, anulados y retenciones cuya compra no está en el sistema | pantalla + CSV (el **XML responde 501**, ver §7) |

Cada generación es una **versión inmutable** (hash SHA-256 del contenido canónico). Regenerar sin cambios devuelve la última; con cambios nace la siguiente. Cada versión trae **hallazgos** (errores y advertencias que hay que revisar antes de declarar), **qué cifras cambiaron** respecto a la anterior y su **conciliación con el libro mayor**.

## 2. Arquitectura

Mismo patrón que `treasury-service` (Hono + Sequelize + Clean Architecture + outbox/inbox de `@facturero/outbox-relay`).

- **Se alimenta de eventos**, no de llamadas síncronas, y mantiene su propio modelo de lectura: `billing.invoice.issued|voided`, `purchasing.bill.posted|voided`, `fiscal.ec.withholding.issued`. Si el servicio está caído, los eventos esperan en RabbitMQ.
- **Publica** (para la bitácora): `reporting.tax_annex.generated`, `reporting.tax_annex.exported`, `reporting.tax_annex.manual_input_set`.
- **Consulta** (solo lectura, server-to-server): contabilidad (plan de cuentas + balance de comprobación, para conciliar por rol) y organización (RUC y razón social del informante del ATS).
- **Todo el dinero en centavos enteros.** Las fechas contables son `AAAA-MM-DD` sin hora (una fecha sin hora no se pasa por la zona horaria: eso la corría un día).

### Modelo de datos (`migrations/20261025100000-create-reporting.cjs`, idempotente)

`report_documents` (un comprobante conocido; UNIQUE por organización + servicio + id de origen), `report_document_taxes` (desglose por tarifa), `report_withholding_lines` (una por concepto de retención, con el comprobante de compra que sustenta), `tax_annex_runs` (versiones; UNIQUE por organización + anexo + periodo + versión), `tax_annex_findings`, `tax_annex_manual_inputs` (UNIQUE por organización + anexo + periodo + casillero), más `outbox_messages` y `processed_events` (la tabla de entrada de la librería).

## 3. Datos que necesitan los anexos y de dónde salen (verificado contra los publicadores reales)

| Dato | Publicador real | Campo | ¿Viaja? |
|---|---|---|---|
| Detalle de la retención por concepto, base, % y valor | `fiscal-ecuador/src/application/withholding-event.ts` | `lines[]` (`tax`, `retentionCode`, `baseCents`, `ratePercent`, `amountCents`) | **Sí** (se añadió; antes solo había totales) |
| Periodo fiscal, tipo de identificación del proveedor, sustento y autorización del comprobante sustento | ídem | `fiscalPeriod`, `supplier.identificationType`, `support.supportCode`, `support.authorizationNumber` | **Sí** (se añadió) |
| Autorización de la compra, tipo de identificación del proveedor, bases e IVA por tarifa | `purchasing-service/src/application/events.ts` (`billPayload`) | `authorizationNumber`, `supplier.identificationType`, `taxBreakdown[]` | **Sí** (se añadió) |
| Forma de pago y sustento tributario de la compra | ídem | `paymentMethodCode`, `supportCode` | **Siempre `null`**: Compras no los captura |
| Tipo, número, fecha, cliente, desglose de IVA de la venta | `billing.invoice.issued` | `documentTypeCode`, `number`, `issueDate`, `customerSnapshot`, `lines[].taxes[]` | Sí (ya viajaban) |
| Autorización de la venta | — | — | **No**: billing no la publica (el ATS de ventas va agrupado y no la pide) |

Los cambios en `purchasing-service` y `fiscal-ecuador` son **aditivos** (campos nuevos; no se quitó ni renombró nada) y llevan su prueba. `billing-service` **no se tocó** (sus cambios sin subir son de tesorería).

## 4. Reglas de cálculo

- **104:** ventas por tarifa = facturas + notas de débito − notas de crédito (tipo `04`). Compras por tarifa. `crédito aplicable = IVA de compras × factor / 10000` (el factor viene en **puntos básicos**; sin valor del contador es **10000 = 100 %**). Liquidación: `IVA generado − crédito aplicable − crédito del mes anterior − IVA que nos retuvieron los clientes ± ajustes`; positivo = a pagar, negativo = a favor. El **IVA que nosotros retuvimos a proveedores no se resta**: se paga aparte y se informa en su propia línea.
- **103:** solo líneas de **renta**, agrupadas por código de concepto (la retención de IVA y el ISD no entran; se informan aparte).
- **ATS:** estructura propia, en centavos. Compras activas con sus retenciones enlazadas; ventas por (identificación, tipo de comprobante); anulados de ventas y retenciones (una compra anulada en Compras no es un comprobante anulado por el informante).
- **Casilleros manuales** (solo 104): `factor_proporcionalidad_bps` (0–10000), `credito_anterior` (≥ 0), `iva_retenido_sufrido` (≥ 0), `ajustes` (con signo). Guardar uno **no** crea versión: hay que generar de nuevo. Cada cambio queda en la bitácora con el valor anterior. Los que no se completaron salen en un hallazgo `MANUAL_FIELDS_PENDING`.
- **Enlace retención ↔ compra:** por (identificación del proveedor + número del comprobante sustento), llegue primero cualquiera de las dos.

### Hallazgos

Error: `INVALID_PARTY_ID` (cédula con verificador mal, certeza alta), `MISSING_PARTY_ID`, `MISSING_AUTHORIZATION` (compras), `INVALID_AUTHORIZATION_FORMAT`, `DUPLICATE_DOCUMENT`.
Advertencia: `INVALID_PARTY_ID` de un RUC de sociedad o entidad pública (hay RUC antiguos válidos que no pasan el módulo 11), `MISSING_PARTY_ID_TYPE`, `MISSING_PARTY_NAME`, `MISSING_SUPPORT_CODE`, `TAX_BASE_MISMATCH`, `NO_TAX_DETAIL`, `WITHHOLDING_WITHOUT_PURCHASE`, `VOIDED_WITH_WITHHOLDING`, `UNKNOWN_DOCUMENT_TYPE`, `MISSING_INFORMANT`, `MANUAL_FIELDS_PENDING`.
El consumidor final (`07` / `9999999999999`) es válido sin dígito verificador ni nombre.

## 5. Concurrencia y orden de llegada (probado)

- Dos eventos del **mismo documento** pueden procesarse a la vez. Si la anulación gana, queda un comprobante provisional (tipo `00`, total 0, anulado) y **la emisión que llega después lo completa conservando que está anulado**. Ante un choque del UNIQUE se reintenta la transacción entera (antes se tomaba por «duplicado» y se **perdían los datos**: lo encontró la verificación real, no las pruebas en memoria).
- Diez generaciones simultáneas del mismo periodo → **una sola versión**.
- Una anulación de compra que llega antes que la compra se guarda ya anulada y la compra tardía no la reactiva.

## 6. HTTP y permisos

Prefijo `/reporting` (el gateway lo reenvía sin quitarlo). `tax_annex:read` (ver, conciliación, comprobantes), `tax_annex:generate` (generar y casilleros), `tax_annex:export` (descargar). Administrador y Contador: los tres; Solo lectura: ver. Contrato: `openapi.yaml` (9 rutas) y `asyncapi.yaml` (3 publicados, 5 consumidos), ambos cotejados con el código por `scripts/check-*.mjs` (también en el CI).

## 7. Límites (lo que NO cubre)

1. **El XML del ATS no existe.** Falta el XSD oficial y su ficha técnica: **respuesta 501 `ATS_SCHEMA_PENDING`**. El ATS se entrega como pantalla y CSV con estructura propia. Una estructura escrita de memoria que no valide contra el XSD sería rechazada por el SRI.
2. **Ningún casillero del 103 ni del 104 está mapeado**: no hay en el repositorio la tabla oficial concepto → casillero. Se muestran por código de concepto y por tarifa; el 103 devuelve `casillero: null`.
3. **No distingue 0 %, «no objeto» y «exento»**: billing y Compras solo traen la tarifa. Caen todos en la base a 0 %.
4. **Sustento tributario y forma de pago de la compra no se capturan** en Compras: **toda compra** sale con la advertencia `MISSING_SUPPORT_CODE`, que el ATS exige.
5. **Solo conoce lo que llegó por eventos**; no hay carga histórica. Las retenciones emitidas antes de este cambio (evento sin `lines`) se omiten con un aviso en el log.
6. **El IVA que nos retuvieron los clientes** (retenciones recibidas) no llega por ningún evento: es un casillero manual.
7. **Factor de proporcionalidad, crédito del mes anterior y ajustes**: manuales (criterio del contador).
8. **`WITHHOLDING_LATE` no está implementado**: el plazo oficial no está en un archivo del repositorio.
9. **Retenciones de ISD** no se cubren (se informan aparte).
10. **Una anulación posterior cambia un periodo ya declarado**: al regenerar sale una versión nueva (base de una declaración sustitutiva), no se «corrige» la anterior. El criterio de en qué periodo cuenta un anulado (emisión o anulación) debe confirmarse con la ficha técnica.
11. **La conciliación** compara el movimiento del periodo de las cuentas por rol; un asiento manual, el pago del impuesto o un documento sin asiento producen diferencias legítimas. Se muestran, no se «ajustan».
12. **El diff entre versiones** es por cifras del resumen, no por documento.
13. Solo periodo **mensual**; zona horaria fija (`ORG_TIMEZONE`, por defecto `America/Guayaquil`). Informante = RUC + razón social (no representante legal, contador ni dirección).
14. El texto de los hallazgos lo escribe el servidor **en español** (las etiquetas de la pantalla sí están en es/en/fr).

## 8. Evidencia (2026-10-23)

- `npm run typecheck`, `npm run build`, `npm test`: **88 pruebas** (dominio, cálculos con cifras hechas a mano, manejadores incluida la carrera, flujo completo con base en memoria **con transacciones reales**, HTTP con permisos).
- `npm run verify:openapi` y `verify:asyncapi`: en verde.
- **`scripts/verify-annexes.mjs`** contra **MySQL, RabbitMQ y contabilidad reales**, organización nueva: 5 corridas seguidas `TODO OK`. Incluye **la prueba de oro**: IVA de ventas, IVA de compras, IVA retenido y renta retenida del 104/103 **= el libro mayor** (`vat_payable`, `vat_credit`, `vat_withholding_payable`, `income_tax_withholding_payable`) leído por SQL directo; la conciliación por HTTP coincide; 10 generaciones simultáneas = 1 versión; duplicados; anulación antes de la emisión; retención antes de la compra; descargas.
- `scripts/local-stack/ui-anexos.cjs` (Playwright; Administrador, Contador, Solo lectura, Vendedor; es/en/fr; 390 px): `TODO OK` (varias corridas).
- Otros repos: gateway 208 (20 nuevas), frontend 443 (12 nuevas), auth 259, plugin-catalog 193, purchasing 161 (2 nuevas), fiscal-ecuador 209 (5 nuevas); `lint:ui`, `check-audit-labels`, `check-permissions --strict` y `npm ci --dry-run` en verde.

## 9. Cómo correrlo

```bash
cd backend/reporting-service
export DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=root123 DB_NAME=reporting_db
npx sequelize-cli db:migrate
npm test && npm run typecheck && npm run verify:openapi && npm run verify:asyncapi
# con la pila local (mysql 3307, rabbitmq, contabilidad :3016): node scripts/verify-annexes.mjs
# por la interfaz: bash scripts/local-stack/arrancar-arbol.sh migrar | servicios | frontend  y  node scripts/local-stack/ui-anexos.cjs
```

## 10. Orden de subida

`auth-service` (permisos) → `plugin-catalog-service` (el módulo nace «en construcción») → `purchasing-service` y `fiscal-ecuador` (campos nuevos en los eventos) → **`reporting-service`** (repo nuevo; sus secretos y base los crea el dueño, ver `COSAS-POR-HACER.md`) → `api-gateway-node` (con `REPORTING_SERVICE_URL`) → `frontend`.
Los eventos publicados **antes** de que el servicio exista no se recuperan: la primera versión solo ve lo posterior. `billing-service` tiene cambios de tesorería sin subir, ajenos a esta fase.
