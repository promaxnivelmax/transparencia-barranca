"use strict";

/* =========================================================
   TRANSPARENCIA BARRANCABERMEJA · app.js
   Creado por Iván Rodríguez, Edil de la Comuna 5

   El tablero NO descarga los miles de contratos: le pide a SECOP
   que haga las sumas y conteos, y solo trae los resultados.
   Así se puede mostrar TODO el historial y la página sigue rápida.

   1. Configuración          7. Gráficos
   2. Utilidades             8. Entidades y contratistas
   3. Memoria (caché)        9. Tabla de contratos
   4. Filtros → consulta    10. Buscador SECOP I y II
   5. Carga del tablero     11. Ficha del contrato
   6. Indicadores y alertas 12. Exportar y arranque
   ========================================================= */

// ===== 1. CONFIGURACIÓN =====

const API_SECOP2 = "https://www.datos.gov.co/resource/jbjy-vk9h.json";   // SECOP II contratos
const API_INTEGRADO = "https://www.datos.gov.co/resource/rpmr-utcd.json"; // SECOP I + SECOP II

// Entidades del Distrito que SECOP registra SIN ciudad (se identifican por NIT)
const NITS_EXTRA = [
  "890201900",  // Alcaldía Distrital de Barrancabermeja
  "829001846",  // Empresa Social del Estado (E.S.E.) Barrancabermeja
  "800024581",  // Instituto Universitario de la Paz (UNIPAZ)
  "8000160643", // Institución Educativa Diego Hernández de Gallegos
  "900112222",  // Institución Educativa Los Laureles
  "829003831"   // Ministerio del Trabajo - Oficina Especial Barrancabermeja
];

const BASE = `(ciudad = 'Barrancabermeja' OR nit_entidad in (${NITS_EXTRA.map(n => `'${n}'`).join(",")}))`;

// Campos de cada contrato (sin cédulas, direcciones ni datos bancarios)
const CAMPOS = [
  "id_contrato", "referencia_del_contrato", "nombre_entidad", "proveedor_adjudicado",
  "tipodocproveedor", "valor_del_contrato", "valor_pagado", "fecha_de_firma",
  "fecha_de_inicio_del_contrato", "fecha_de_fin_del_contrato", "objeto_del_contrato",
  "modalidad_de_contratacion", "tipo_de_contrato", "estado_contrato", "dias_adicionados", "urlproceso"
];

const CAMPOS_INTEGRADO = [
  "nombre_de_la_entidad", "municipio_entidad", "estado_del_proceso", "modalidad_de_contrataci_n",
  "objeto_a_contratar", "objeto_del_proceso", "tipo_de_contrato", "fecha_de_firma_del_contrato",
  "fecha_inicio_ejecuci_n", "fecha_fin_ejecuci_n", "numero_del_contrato", "numero_de_proceso",
  "valor_contrato", "nom_raz_social_contratista", "url_contrato", "origen", "tipo_documento_proveedor"
];

const HORAS_CACHE = 6;
const HORAS_RESUMEN = 48;     // si el resumen tiene más de 2 días, se consulta en vivo
const FILAS_TABLA = 100;
const PRIMER_ANIO = 2017;

const ESTADOS = {
  "en ejecución": "En ejecución", "en ejecucion": "En ejecución", "aprobado": "Aprobado, sin iniciar",
  "modificado": "Modificado", "cedido": "Cedido", "suspendido": "Suspendido",
  "terminado": "Terminado", "cerrado": "Cerrado", "liquidado": "Liquidado",
  "celebrado": "Celebrado", "terminado sin liquidar": "Terminado", "terminado anormalmente después de convocado": "Terminado"
};
const TERMINADOS = ["Terminado", "Cerrado", "Liquidado"];
const DOCS_PERSONA = ["Cédula de Ciudadanía", "Cédula de Extranjería", "Pasaporte", "Permiso por Protección Temporal", "Nit de Persona Natural"];

const app = {
  indice: new Map(),       // contratos ya vistos (para abrir su ficha)
  vista: null,             // alerta seleccionada
  graficos: {},
  filas: [],               // contratos mostrados en la tabla
  totalContratos: 0,
  resultados: {},          // últimos resultados del tablero
  alertas: [],
  memoria: new Map(),      // resultados ya consultados en esta visita
  resumen: null,           // datos/resumen.json (calculado cada día en GitHub)
  turno: 0                 // evita pintar resultados viejos si cambias filtros rápido
};

// ===== 2. UTILIDADES =====

const $ = id => document.getElementById(id);
const numero = n => Number(n || 0).toLocaleString("es-CO");
const pesos = v => Number(v || 0).toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const porcentaje = (parte, total) =>
  total ? (parte / total * 100).toLocaleString("es-CO", { maximumFractionDigits: 1 }) + " %" : "0 %";

function pesosCorto(valor) {
  const f = n => n.toLocaleString("es-CO", { maximumFractionDigits: 1 });
  valor = Number(valor || 0);
  if (valor >= 1e12) return "$ " + f(valor / 1e12) + " billones";
  if (valor >= 1e9) return "$ " + f(valor / 1e9) + " mil millones";
  if (valor >= 1e6) return "$ " + f(valor / 1e6) + " millones";
  return pesos(valor);
}

function escapar(texto) {
  const div = document.createElement("div");
  div.textContent = texto == null ? "" : String(texto);
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const fecha = t => t ? t.slice(0, 10) : "Sin dato";
const recortar = (t, max = 40) => !t ? "" : t.length > max ? t.slice(0, max) + "…" : t;
const esperar = ms => new Promise(r => setTimeout(r, ms));
const hoyISO = (dias = 0) => new Date(Date.now() + dias * 864e5).toISOString().slice(0, 10);

function clasificarEstado(estado) {
  const clave = (estado || "").trim().toLowerCase();
  if (!clave) return "Sin información";
  return ESTADOS[clave] || estado;
}

function clasificarTipo(doc) {
  if (doc === "NIT" || doc === "Nit de Persona Jurídica") return "Empresa";
  if (DOCS_PERSONA.includes(doc)) return "Persona natural";
  return "Sin clasificar";
}

function claseEstado(estado) {
  if (estado === "En ejecución") return "ejecucion";
  if (TERMINADOS.includes(estado)) return "terminado";
  if (estado === "Modificado") return "modificado";
  if (["Suspendido", "Sin información"].includes(estado)) return "alerta";
  return "";
}

// Texto seguro para usar dentro de una consulta a SECOP
function textoConsulta(t) {
  return t.toUpperCase().replace(/['%_\\]/g, " ").replace(/\s+/g, " ").trim();
}
// Valor exacto entre comillas para la consulta (duplica las comillas simples)
const literal = v => `'${String(v).replace(/'/g, "''")}'`;

async function consultar(url, intentos = 3, senal) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, senal ? { signal: senal } : undefined);
      if (!r.ok) throw new Error("La API respondió con error " + r.status);
      const datos = await r.json();
      if (!Array.isArray(datos)) throw new Error("Respuesta inesperada de la API");
      return datos;
    } catch (error) {
      if (error.name === "AbortError" || i === intentos) throw error;
      await esperar(1500 * i);
    }
  }
}

// Consulta a SECOP II con parámetros SoQL
function secop2(parametros) {
  return consultar(`${API_SECOP2}?${new URLSearchParams(parametros)}`);
}

// ===== 3. MEMORIA (CACHÉ) =====
// Guarda los resultados en el navegador: la siguiente visita carga al instante.

function abrirMemoria() {
  return new Promise((ok, falla) => {
    if (!("indexedDB" in window)) return falla(new Error("Sin memoria"));
    const pedido = indexedDB.open("transparencia-barranca", 2);
    pedido.onupgradeneeded = () => { if (!pedido.result.objectStoreNames.contains("datos")) pedido.result.createObjectStore("datos"); };
    pedido.onsuccess = () => ok(pedido.result);
    pedido.onerror = () => falla(pedido.error);
  });
}

async function leerMemoria(clave) {
  try {
    const db = await abrirMemoria();
    return await new Promise(ok => {
      const p = db.transaction("datos").objectStore("datos").get(clave);
      p.onsuccess = () => ok(p.result || null);
      p.onerror = () => ok(null);
    });
  } catch { return null; }
}

async function guardarMemoria(clave, valor) {
  try {
    const db = await abrirMemoria();
    db.transaction("datos", "readwrite").objectStore("datos").put(valor, clave);
  } catch { /* si no se puede guardar, no pasa nada */ }
}

// Resumen de todos los años, calculado cada día por GitHub Actions
let promesaResumen = null;
function cargarResumen() {
  if (!promesaResumen) {
    // Misma dirección que el «preload» del index.html: el navegador ya la empezó a descargar
    promesaResumen = fetch("datos/resumen.json", { cache: "no-cache" })
      .then(r => r.ok ? r.json() : null)
      .then(d => (app.resumen = d))
      .catch(() => null);
  }
  return promesaResumen;
}
const resumenFresco = () => app.resumen && (Date.now() - app.resumen.fecha) < HORAS_RESUMEN * 3600e3;

// ===== 4. FILTROS → CONSULTA =====

function condicionPeriodo() {
  const anio = $("anio").value;
  if (!anio) return "";
  const a = Number(anio);
  return `fecha_de_firma >= '${a}-01-01T00:00:00' AND fecha_de_firma < '${a + 1}-01-01T00:00:00'`;
}

// Condiciones de los filtros (sin la alerta seleccionada)
function condicionFiltros() {
  const partes = [BASE];
  const periodo = condicionPeriodo();
  if (periodo) partes.push(periodo);

  const texto = textoConsulta($("buscador").value);
  if (texto.length >= 3) {
    partes.push(`(upper(proveedor_adjudicado) like '%${texto}%' OR upper(nombre_entidad) like '%${texto}%'` +
      ` OR upper(objeto_del_contrato) like '%${texto}%' OR upper(referencia_del_contrato) like '%${texto}%')`);
  }
  if ($("filtroEntidad").value) partes.push(`nombre_entidad = ${literal($("filtroEntidad").value)}`);
  if ($("filtroModalidad").value) partes.push(`modalidad_de_contratacion = ${literal($("filtroModalidad").value)}`);
  if ($("filtroEstado").value) partes.push(`estado_contrato = ${literal($("filtroEstado").value)}`);

  const tipo = $("filtroTipo").value;
  if (tipo === "Empresa") partes.push(`tipodocproveedor = 'NIT'`);
  if (tipo === "Persona natural") partes.push(`tipodocproveedor in (${DOCS_PERSONA.map(literal).join(",")})`);

  return partes.join(" AND ");
}

// Reglas de las alertas, escritas como condiciones de consulta
function reglasAlertas(contratistasMuchos = []) {
  const hoy = hoyISO(), en30 = hoyISO(30), hace90 = hoyISO(-90);
  return [
    { id: "directaGrande", clase: "", titulo: "Contratación directa de $500 millones o más",
      texto: "Contratos grandes que se adjudicaron sin competencia abierta.",
      condicion: `modalidad_de_contratacion = 'Contratación directa' AND valor_del_contrato >= 500000000` },
    { id: "muyGrandes", clase: "dorada", titulo: "Contratos de $10.000 millones o más",
      texto: "Los contratos más grandes. Revisa también si el valor está bien digitado en SECOP.",
      condicion: `valor_del_contrato >= 10000000000` },
    { id: "vencidos", clase: "roja", titulo: "Fecha final vencida, pero siguen «en ejecución»",
      texto: "Ya pasó su fecha de terminación y SECOP los sigue mostrando en ejecución. Puede ser falta de actualización o una prórroga sin reportar.",
      condicion: `estado_contrato = 'En ejecución' AND fecha_de_fin_del_contrato < '${hoy}T00:00:00'` },
    { id: "vencenPronto", clase: "dorada", titulo: "Terminan en los próximos 30 días",
      texto: "Buen momento para preguntar por los resultados y entregables.",
      condicion: `estado_contrato = 'En ejecución' AND fecha_de_fin_del_contrato >= '${hoy}T00:00:00' AND fecha_de_fin_del_contrato <= '${en30}T23:59:59'` },
    { id: "muchosContratos", clase: "", titulo: "Contratistas con 5 o más contratos en ejecución a la vez",
      texto: "Revisa si una misma persona o empresa puede cumplir tantos contratos al mismo tiempo.",
      condicion: contratistasMuchos.length
        ? `estado_contrato = 'En ejecución' AND proveedor_adjudicado in (${contratistasMuchos.map(literal).join(",")})`
        : "1 = 0" },
    { id: "sinPagos", clase: "dorada", titulo: "En ejecución hace más de 90 días, sin pagos reportados",
      texto: "La entidad no ha reportado pagos en SECOP. Puede ser falta de reporte, no necesariamente falta de pago.",
      condicion: `estado_contrato = 'En ejecución' AND valor_pagado = 0 AND valor_del_contrato > 0 AND fecha_de_inicio_del_contrato < '${hace90}T00:00:00'` }
  ];
}

// Condición completa: filtros + alerta seleccionada
function condicionCompleta() {
  const base = condicionFiltros();
  const regla = app.vista && app.alertas.find(a => a.id === app.vista);
  return regla ? `${base} AND (${regla.condicion})` : base;
}

// ===== 5. CARGA DEL TABLERO =====

function consultasTablero(where) {
  const porAnio = !$("anio").value;
  const tiempo = porAnio ? "date_extract_y(fecha_de_firma)" : "date_trunc_ym(fecha_de_firma)";
  const sumaSi = (cond, nombre) => `sum(case(${cond}, 1, true, 0)) as ${nombre}`;

  return {
    resumen: secop2({ $select: "count(id_contrato) as n, sum(valor_del_contrato) as v, sum(valor_pagado) as p, count(distinct proveedor_adjudicado) as c", $where: where }),
    modalidades: secop2({ $select: "modalidad_de_contratacion as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: where, $group: "modalidad_de_contratacion", $order: "n DESC" }),
    estados: secop2({ $select: "estado_contrato as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: where, $group: "estado_contrato", $order: "n DESC" }),
    documentos: secop2({ $select: "tipodocproveedor as k, count(id_contrato) as n, sum(valor_del_contrato) as v, count(distinct proveedor_adjudicado) as c", $where: where, $group: "tipodocproveedor" }),
    entidades: secop2({ $select: `nombre_entidad as k, count(id_contrato) as n, sum(valor_del_contrato) as v, ${sumaSi("estado_contrato = 'En ejecución'", "ej")}, ${sumaSi("modalidad_de_contratacion = 'Contratación directa'", "dir")}`,
                        $where: where, $group: "nombre_entidad", $order: "v DESC", $limit: 200 }),
    tiempo: secop2({ $select: `${tiempo} as k, count(id_contrato) as n, sum(valor_del_contrato) as v`, $where: where, $group: "k", $order: "k" }),
    tiposContrato: secop2({ $select: "tipo_de_contrato as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: where, $group: "tipo_de_contrato", $order: "v DESC", $limit: 8 }),
    contratistas: secop2({ $select: `proveedor_adjudicado as k, max(tipodocproveedor) as doc, count(id_contrato) as n, sum(valor_del_contrato) as v, ${sumaSi("estado_contrato = 'En ejecución'", "ej")}, count(distinct nombre_entidad) as e`,
                           $where: where, $group: "proveedor_adjudicado", $order: "v DESC", $limit: 50 })
  };
}

async function cargarTablero() {
  const turno = ++app.turno;
  const where = condicionCompleta();
  const sinFiltros = where === BASE && !$("anio").value;
  const clave = "tablero|" + where;

  marcarCargando(true);
  pintarContratos(true); // la tabla se carga por su lado

  // 0) Sin filtros: se usa el resumen ya calculado (carga instantánea)
  if (sinFiltros) {
    await cargarResumen();
    if (turno !== app.turno) return;
    if (resumenFresco()) {
      pintarTablero(app.resumen.tablero);
      marcarCargando(false, app.resumen.fecha);
      return;
    }
  }

  // 1) Resultados guardados (de esta visita o de visitas anteriores)
  let guardado = app.memoria.get(clave) || (sinFiltros ? await leerMemoria(clave) : null);
  if (guardado && turno === app.turno) pintarTablero(guardado.datos);
  const fresco = guardado && (Date.now() - guardado.fecha) < HORAS_CACHE * 3600e3;
  if (fresco) { marcarCargando(false, guardado.fecha); return; }

  // 2) Consultas a SECOP en paralelo; cada parte se pinta apenas llega
  const consultas = consultasTablero(where);
  const datos = {};
  try {
    await Promise.all(Object.entries(consultas).map(async ([nombre, promesa]) => {
      datos[nombre] = await promesa;
      if (turno === app.turno && !guardado) pintarParcial(nombre, datos);
    }));
    if (turno !== app.turno) return;
    pintarTablero(datos);
    const paquete = { datos, fecha: Date.now() };
    app.memoria.set(clave, paquete);
    if (sinFiltros) guardarMemoria(clave, paquete);
    marcarCargando(false, paquete.fecha);
  } catch (error) {
    console.error(error);
    if (turno === app.turno) {
      $("estadoCarga").textContent = guardado
        ? "No se pudo actualizar; se muestran los últimos datos guardados."
        : "SECOP no respondió. Revisa tu internet y vuelve a intentar en un momento.";
    }
  }
}

function marcarCargando(cargando, fechaDatos) {
  document.body.classList.toggle("cargando", cargando);
  const periodo = $("anio").value ? `de ${$("anio").value}` : "de todos los años";
  if (cargando) {
    $("estadoCarga").textContent = `Consultando SECOP ${periodo}…`;
  } else {
    const cuando = new Date(fechaDatos).toLocaleString("es-CO");
    $("estadoCarga").textContent = `${numero(app.totalContratos)} contratos ${periodo} · datos de ${cuando}`;
    $("actualizacion").textContent = `Datos consultados en SECOP el ${cuando}.`;
  }
}

// Para pintar por partes mientras llegan las consultas
function pintarParcial(nombre, datos) {
  if (nombre === "resumen" || nombre === "modalidades" || nombre === "estados" || nombre === "documentos" || nombre === "contratistas") {
    if (datos.resumen) pintarIndicadores(datos);
  }
  if (nombre === "entidades" && datos.resumen) pintarEntidades(datos);
  if (nombre === "contratistas" && datos.resumen) pintarContratistas(datos);
  pintarGraficos(datos);
}

function pintarTablero(datos) {
  app.resultados = datos;
  if (!app.listasListas) llenarListas(datos);
  pintarIndicadores(datos);
  pintarGraficos(datos);
  pintarEntidades(datos);
  pintarContratistas(datos);
}

function llenarSelect(id, valores, textoTodos, etiqueta = v => v) {
  const select = $(id);
  const actual = select.value;
  select.innerHTML = "";
  select.add(new Option(textoTodos, ""));
  valores.forEach(v => select.add(new Option(etiqueta(v), v)));
  if (valores.includes(actual)) select.value = actual;
}

// Las listas de los filtros se llenan con los datos sin filtrar
function llenarListas(datos) {
  if (condicionCompleta() !== BASE || $("anio").value) return;
  const claves = lista => (lista || []).map(x => x.k).filter(Boolean).sort((a, b) => a.localeCompare(b, "es"));
  llenarSelect("filtroEntidad", claves(datos.entidades), "Todas las entidades");
  llenarSelect("filtroModalidad", claves(datos.modalidades), "Todas las modalidades");
  llenarSelect("filtroEstado", claves(datos.estados), "Todos los estados", clasificarEstado);
  app.listasListas = true;
}

let pausaFiltros;
function aplicarFiltros() {
  clearTimeout(pausaFiltros);
  pausaFiltros = setTimeout(() => {
    $("vistaEspecial").hidden = !app.vista;
    const regla = app.vista && app.alertas.find(a => a.id === app.vista);
    if (regla) $("vistaEspecialTexto").textContent = "Mostrando: " + regla.titulo;
    cargarTablero();
    cargarAlertas();
  }, 300);
}

function limpiarFiltrosSinCargar() {
  $("buscador").value = "";
  ["filtroEntidad", "filtroModalidad", "filtroEstado", "filtroTipo"].forEach(id => $(id).value = "");
  app.vista = null;
}

function limpiarFiltros() {
  limpiarFiltrosSinCargar();
  aplicarFiltros();
}

function irA(pestana) {
  document.querySelectorAll(".pestana").forEach(s => s.classList.toggle("activa", s.dataset.tab === pestana));
  document.querySelectorAll(".pestana-btn").forEach(b => b.classList.toggle("activa", b.dataset.tab === pestana));
  $("barraFiltros").classList.toggle("oculto", ["buscar", "metodologia"].includes(pestana));
  if (pestana === "inicio") Object.values(app.graficos).forEach(g => g.resize());
  if (pestana === "secretarias") pintarSecretarias();

  // La portada con la ilustración solo se ve en «Inicio»; en las demás pestañas el contenido aparece arriba
  document.body.dataset.pestana = pestana;
  window.scrollTo({ top: 0, behavior: "smooth" });
  history.replaceState(null, "", "#" + pestana);
}

// ===== 6. INDICADORES Y ALERTAS =====

function pintarIndicadores(d) {
  const r = (d.resumen && d.resumen[0]) || {};
  const total = Number(r.v) || 0;
  app.totalContratos = Number(r.n) || 0;

  $("kpiContratos").textContent = numero(r.n);
  $("kpiContratosNota").textContent = $("anio").value ? `firmados en ${$("anio").value}` : `desde ${PRIMER_ANIO} hasta hoy`;
  $("kpiValor").textContent = pesosCorto(total);
  $("kpiValorNota").textContent = pesos(total);

  if (d.modalidades) {
    const dir = d.modalidades.find(m => m.k === "Contratación directa") || { n: 0, v: 0 };
    $("kpiDirecta").textContent = porcentaje(Number(dir.n), Number(r.n));
    $("kpiDirectaNota").textContent = `${numero(dir.n)} contratos · ${porcentaje(Number(dir.v), total)} del valor`;
  }

  $("kpiContratistas").textContent = numero(r.c);
  if (d.documentos) {
    const empresas = d.documentos.filter(x => clasificarTipo(x.k) === "Empresa").reduce((s, x) => s + Number(x.c), 0);
    const personas = d.documentos.filter(x => clasificarTipo(x.k) === "Persona natural").reduce((s, x) => s + Number(x.c), 0);
    $("kpiContratistasNota").textContent = `${numero(empresas)} empresas · ${numero(personas)} personas`;
  }

  if (d.estados) {
    const suma = filtro => d.estados.filter(e => filtro(clasificarEstado(e.k))).reduce((s, e) => s + Number(e.n), 0);
    $("kpiEjecucion").textContent = numero(suma(e => e === "En ejecución"));
    $("kpiEjecucionNota").textContent = `${numero(suma(e => TERMINADOS.includes(e)))} terminados o cerrados`;
  }

  if (d.contratistas) {
    const top10 = d.contratistas.slice(0, 10).reduce((s, x) => s + Number(x.v), 0);
    $("kpiConcentracion").textContent = porcentaje(top10, total);
  }

  $("kpiPagado").textContent = porcentaje(Number(r.p) || 0, total);
  $("kpiPagadoNota").textContent = `${pesosCorto(r.p)} pagados según SECOP`;
}

// Las alertas se calculan con los filtros (sin la alerta seleccionada)
async function cargarAlertas() {
  const where = condicionFiltros();
  const clave = "alertas|" + where;

  // Sin filtros: alertas ya calculadas en el resumen
  if (where === BASE) {
    await cargarResumen();
    if (resumenFresco() && app.resumen.alertas) {
      const { muchos, conteos } = app.resumen.alertas;
      app.alertas = reglasAlertas(muchos).map(r => ({ ...r, n: conteos[r.id]?.n || 0, valor: conteos[r.id]?.valor || 0 }));
      pintarAlertas();
      return;
    }
  }
  const guardado = app.memoria.get(clave);
  if (guardado) { app.alertas = guardado; pintarAlertas(); return; }

  try {
    const muchos = await secop2({
      $select: "proveedor_adjudicado as k, count(id_contrato) as n",
      $where: `${where} AND estado_contrato = 'En ejecución'`,
      $group: "proveedor_adjudicado", $having: "n >= 5", $order: "n DESC", $limit: 300
    });
    const reglas = reglasAlertas(muchos.map(m => m.k).filter(Boolean));
    const conteos = await Promise.all(reglas.map(r =>
      r.condicion === "1 = 0" ? [{ n: 0, v: 0 }] :
      secop2({ $select: "count(id_contrato) as n, sum(valor_del_contrato) as v", $where: `${where} AND (${r.condicion})` })));
    if (where !== condicionFiltros()) return; // los filtros cambiaron mientras tanto
    app.alertas = reglas.map((r, i) => ({ ...r, n: Number(conteos[i][0]?.n) || 0, valor: Number(conteos[i][0]?.v) || 0 }));
    app.memoria.set(clave, app.alertas);
    pintarAlertas();
  } catch (error) {
    console.error(error);
    $("listaAlertas").innerHTML = "<p>No se pudieron calcular las alertas. Intenta de nuevo en un momento.</p>";
  }
}

function pintarAlertas() {
  $("listaAlertas").innerHTML = app.alertas.map(a => `
    <button class="tarjeta-alerta ${a.clase}" data-alerta="${a.id}">
      <h3>${escapar(a.titulo)}</h3>
      <strong>${numero(a.n)}</strong>
      <p>${escapar(a.texto)}</p>
      <em>${pesosCorto(a.valor)} en total · Ver contratos →</em>
    </button>`).join("");
  $("kpiAlertas").textContent = numero(app.alertas.reduce((s, a) => s + a.n, 0));
}

// ===== 7. GRÁFICOS =====

const color = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function dibujar(id, configuracion) {
  if (app.graficos[id]) app.graficos[id].destroy();
  app.graficos[id] = new Chart($(id), configuracion);
}

function sumarPor(lista, clasificar) {
  const grupos = {};
  (lista || []).forEach(x => {
    const k = clasificar(x.k);
    if (!grupos[k]) grupos[k] = { n: 0, v: 0 };
    grupos[k].n += Number(x.n) || 0;
    grupos[k].v += Number(x.v) || 0;
  });
  return Object.entries(grupos);
}

function pintarGraficos(d) {
  if (typeof Chart === "undefined") return; // con «defer», Chart.js ya está listo cuando corre este archivo
  Chart.defaults.color = color("--texto-suave");
  Chart.defaults.borderColor = "rgba(255,255,255,0.07)";
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.maintainAspectRatio = false;

  // Paleta de marca: amarillo #ffc123 y escala de grises
  const paleta = ["#ffc123", "#e6e6e6", "#9e9e9e", "#ffd666", "#6b6b6b", "#fff0c2", "#4a4a4a", "#cfcfcf"];
  const enMillones = { callbacks: { label: ctx => " " + pesosCorto(ctx.raw * 1e6) } };
  const leyenda = { position: "bottom", labels: { boxWidth: 12 } };
  const millones = v => (Number(v) || 0) / 1e6;

  if (d.entidades) {
    const top = d.entidades.slice(0, 10);
    dibujar("gEntidades", {
      type: "bar",
      data: { labels: top.map(e => recortar(e.k || "Sin dato", 50)),
              datasets: [{ data: top.map(e => millones(e.v)), backgroundColor: color("--verde-claro"), borderRadius: 8 }] },
      options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: enMillones },
                 scales: { x: { title: { display: true, text: "Millones de pesos" } } } }
    });
  }

  if (d.tiempo) {
    const filas = d.tiempo.filter(t => t.k);
    const porAnio = !$("anio").value;
    $("tituloTiempo").textContent = porAnio ? "Contratación por año" : "Contratación mes a mes";
    dibujar("gMeses", {
      type: porAnio ? "bar" : "line",
      data: { labels: filas.map(t => porAnio ? t.k : t.k.slice(0, 7)),
              datasets: [{ data: filas.map(t => millones(t.v)), borderColor: color("--dorado"), backgroundColor: porAnio ? color("--dorado") : "rgba(255,193,35,0.15)",
                           fill: true, tension: 0.35, pointRadius: 3, borderRadius: 8 }] },
      options: { plugins: { legend: { display: false }, tooltip: enMillones } }
    });
  }

  if (d.modalidades) {
    dibujar("gModalidad", {
      type: "doughnut",
      data: { labels: d.modalidades.map(m => m.k || "Sin dato"), datasets: [{ data: d.modalidades.map(m => Number(m.n)), backgroundColor: paleta, borderWidth: 0 }] },
      options: { cutout: "62%", plugins: { legend: leyenda } }
    });
  }

  if (d.documentos) {
    const tipos = sumarPor(d.documentos, clasificarTipo);
    dibujar("gTipo", {
      type: "doughnut",
      data: { labels: tipos.map(t => t[0]), datasets: [{ data: tipos.map(t => millones(t[1].v)), backgroundColor: ["#ffc123", "#9e9e9e", "#4a4a4a"], borderWidth: 0 }] },
      options: { cutout: "62%", plugins: { legend: leyenda, tooltip: enMillones } }
    });
  }

  if (d.tiposContrato) {
    dibujar("gTipoContrato", {
      type: "bar",
      data: { labels: d.tiposContrato.map(t => recortar(t.k || "Sin dato", 28)),
              datasets: [{ data: d.tiposContrato.map(t => millones(t.v)), backgroundColor: paleta, borderRadius: 8 }] },
      options: { plugins: { legend: { display: false }, tooltip: enMillones } }
    });
  }

  if (d.estados) {
    const estados = sumarPor(d.estados, clasificarEstado).sort((a, b) => b[1].n - a[1].n);
    dibujar("gEstados", {
      type: "bar",
      data: { labels: estados.map(e => e[0]), datasets: [{ data: estados.map(e => e[1].n), backgroundColor: paleta, borderRadius: 8 }] },
      options: { plugins: { legend: { display: false } } }
    });
  }
}

// ===== 8. ENTIDADES Y CONTRATISTAS =====

function pintarEntidades(d) {
  if (!d.entidades) return;
  $("tarjetasEntidades").innerHTML = d.entidades.map(e => `
    <button class="tarjeta-entidad" data-entidad="${escapar(e.k || "")}">
      <h3>${escapar(e.k || "Sin dato")}</h3>
      <div class="monto">${pesosCorto(e.v)}</div>
      <div class="datos">
        <div><b>${numero(e.n)}</b>contratos</div>
        <div><b>${numero(e.ej)}</b>en ejecución</div>
        <div><b>${porcentaje(Number(e.dir), Number(e.n))}</b>directa</div>
      </div>
    </button>`).join("") || "<p>No hay contratos con estos filtros.</p>";
}

function pintarContratistas(d) {
  if (!d.contratistas || !d.resumen) return;
  const total = Number(d.resumen[0]?.v) || 0;
  const mayor = Number(d.contratistas[0]?.v) || 1;
  $("tablaContratistas").innerHTML = d.contratistas.map((x, i) => `
    <tr class="clic" data-contratista="${escapar(x.k || "")}">
      <td>${i + 1}</td>
      <td>${escapar(x.k || "Sin dato")}</td>
      <td><span class="etiqueta">${clasificarTipo(x.doc)}</span></td>
      <td class="num">${numero(x.n)}</td>
      <td class="num">${numero(x.ej)}</td>
      <td class="num">${numero(x.e)}</td>
      <td class="valor">${pesosCorto(x.v)}</td>
      <td class="num">${porcentaje(Number(x.v), total)}<div class="barra"><i style="width:${(Number(x.v) / mayor * 100).toFixed(1)}%"></i></div></td>
    </tr>`).join("") || `<tr><td colspan="8">No hay contratos con estos filtros.</td></tr>`;
}

// Secretarías y dependencias de la Alcaldía (vienen del resumen diario)
let promesaSecretarias = null;
async function pintarSecretarias() {
  if (!promesaSecretarias) {
    promesaSecretarias = fetch("datos/secretarias.json", { cache: "no-cache" })
      .then(r => r.ok ? r.json() : null).catch(() => null);
  }
  const s = await promesaSecretarias;
  app.secretarias = s;
  if (!s) { $("tarjetasSecretarias").innerHTML = "<p>Todavía no hay datos de secretarías. Se generan con la actualización diaria.</p>"; return; }

  $("notaSecretarias").textContent =
    `${numero(s.total)} contratos de la Alcaldía en SECOP II, de todos los años, repartidos en ${s.unidades.length} secretarías y dependencias. ` +
    `Datos del ${new Date(s.fecha).toLocaleDateString("es-CO")}. Haz clic en una para ver con quién contrata.`;

  $("tarjetasSecretarias").innerHTML = s.unidades.map((u, i) => `
    <button class="tarjeta-entidad" data-secretaria="${i}">
      <h3>${escapar(u.nombre)}</h3>
      <div class="monto">${pesosCorto(u.v)}</div>
      <div class="datos">
        <div><b>${numero(u.n)}</b>contratos</div>
        <div><b>${numero(u.ej)}</b>en ejecución</div>
        <div><b>${porcentaje(u.dir, u.n)}</b>directa</div>
      </div>
    </button>`).join("");
}

function verSecretaria(i) {
  const u = app.secretarias.unidades[i];
  const filaCorta = c => `
    <tr class="clic" data-id="${escapar(c.id)}">
      <td>${escapar(c.f)}</td><td>${escapar(c.ref)}</td><td>${escapar(c.prov)}</td>
      <td class="objeto">${escapar(recortar(c.obj, 90))}</td>
      <td><span class="etiqueta ${claseEstado(clasificarEstado(c.est))}">${escapar(clasificarEstado(c.est))}</span></td>
      <td class="valor">${pesos(c.v)}</td>
      <td>${c.u ? botonSecop(c.u) : `<button class="boton-secop" data-abrir-secop="${escapar(c.id)}">Ver en SECOP ↗</button>`}</td>
    </tr>`;
  const tabla = filas => `<div class="tabla-contenedor"><table>
      <thead><tr><th>Firma</th><th>Contrato</th><th>Contratista</th><th>Objeto</th><th>Estado</th><th>Valor</th><th>Página oficial</th></tr></thead>
      <tbody>${filas.map(filaCorta).join("")}</tbody></table></div>`;

  $("detalleSecretaria").hidden = false;
  $("detalleSecretaria").innerHTML = `
    <div class="detalle-cabecera">
      <div>
        <h2>${escapar(u.nombre)}</h2>
        ${u.otrosNombres.length ? `<p class="nota-pequena">También aparece en SECOP como: ${u.otrosNombres.map(escapar).join(" · ")}</p>` : ""}
      </div>
      <button class="boton-secundario" id="btnCerrarSecretaria">Cerrar ✕</button>
    </div>
    <div class="detalle-cifras">
      <div><span>Valor contratado</span><b>${pesosCorto(u.v)}</b></div>
      <div><span>Contratos</span><b>${numero(u.n)}</b></div>
      <div><span>En ejecución</span><b>${numero(u.ej)}</b></div>
      <div><span>Contratación directa</span><b>${porcentaje(u.dir, u.n)}</b></div>
    </div>
    <div class="detalle-columnas">
      <div>
        <h3>Valor contratado por año</h3>
        <div class="lienzo"><canvas id="gSecretaria"></canvas></div>
      </div>
      <div>
        <h3>Contratistas con más recursos en esta dependencia</h3>
        <div class="tabla-contenedor"><table>
          <thead><tr><th>Contratista</th><th>Tipo</th><th>Contratos</th><th>Valor</th></tr></thead>
          <tbody>${u.contratistas.map(k => `<tr class="clic" data-contratista="${escapar(k.k)}"><td>${escapar(k.k)}</td>
            <td><span class="etiqueta">${k.empresa ? "Empresa" : "Persona"}</span></td><td class="num">${numero(k.n)}</td>
            <td class="valor">${pesosCorto(k.v)}</td></tr>`).join("")}</tbody></table></div>
      </div>
    </div>
    <h3>Contratos más grandes</h3>
    ${tabla(u.mayores)}
    <h3>Contratos más recientes</h3>
    ${tabla(u.recientes)}
    <p class="nota-pequena">Haz clic en un contrato para ver su ficha, o en un contratista para ver todos sus contratos.</p>`;

  if (typeof Chart !== "undefined") {
    const anios = u.anios.filter(a => a[0] !== "Sin fecha");
    dibujar("gSecretaria", {
      type: "bar",
      data: { labels: anios.map(a => a[0]), datasets: [{ data: anios.map(a => a[1] / 1e6), backgroundColor: color("--dorado"), borderRadius: 8 }] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => " " + pesosCorto(ctx.raw * 1e6) } } } }
    });
  }
  $("detalleSecretaria").scrollIntoView({ behavior: "smooth" });
}

// ===== 9. TABLA DE CONTRATOS =====

function prepararSecop2(c) {
  return {
    id: c.id_contrato,
    referencia: c.referencia_del_contrato || c.id_contrato,
    entidad: c.nombre_entidad || "Sin dato",
    contratista: c.proveedor_adjudicado || "Sin dato",
    tipo: clasificarTipo(c.tipodocproveedor),
    objeto: c.objeto_del_contrato || "",
    tipoContrato: c.tipo_de_contrato || "Sin dato",
    modalidad: c.modalidad_de_contratacion || "Sin dato",
    valor: Number(c.valor_del_contrato) || 0,
    pagado: Number(c.valor_pagado) || 0,
    firma: c.fecha_de_firma || "",
    inicio: c.fecha_de_inicio_del_contrato || "",
    fin: c.fecha_de_fin_del_contrato || "",
    estado: clasificarEstado(c.estado_contrato),
    estadoOriginal: c.estado_contrato || "",
    diasAdicionados: c.dias_adicionados || "0",
    origen: "SECOP II",
    url: c.urlproceso?.url || ""
  };
}

function filaContrato(c, conOrigen = false) {
  return `
    <tr class="clic" data-id="${escapar(c.id)}">
      <td>${fecha(c.firma)}</td>
      <td>${escapar(c.referencia)}</td>
      <td>${escapar(recortar(c.entidad, 45))}</td>
      <td><button class="enlace-contratista" data-perfil="${escapar(c.contratista)}">${escapar(c.contratista)}</button></td>
      <td class="objeto">${escapar(recortar(c.objeto, 110))}</td>
      <td><span class="etiqueta ${claseEstado(c.estado)}">${escapar(c.estado)}</span></td>
      ${conOrigen ? `<td><span class="etiqueta">${escapar(c.origen)}</span></td>` : ""}
      <td class="valor">${pesos(c.valor)}</td>
      <td>${botonSecop(c.url)}</td>
    </tr>`;
}

let turnoTabla = 0;
async function pintarContratos(desdeCero) {
  const turno = desdeCero ? ++turnoTabla : turnoTabla;
  if (desdeCero) {
    app.filas = [];
    $("tablaContratos").innerHTML = `<tr><td colspan="8">Cargando contratos…</td></tr>`;
    $("contador").textContent = "Cargando…";
  }
  const orden = $("ordenContratos").value === "valor" ? "valor_del_contrato DESC" : "fecha_de_firma DESC";
  $("btnMas").disabled = true;
  try {
    const porFecha = $("ordenContratos").value !== "valor";
    const where = condicionCompleta() + (porFecha ? " AND fecha_de_firma IS NOT NULL" : "");

    // Sin filtros: los 100 contratos más recientes ya vienen en el resumen diario
    if (desdeCero && porFecha && condicionCompleta() === BASE && !$("anio").value) {
      await cargarResumen();
      const t = resumenFresco() && app.resumen.tablero;
      if (t && t.tabla && t.tablaConteo) {
        if (turno !== turnoTabla) return;
        app.conteoTabla = t.tablaConteo[0];
        app.filas = t.tabla.map(prepararSecop2);
        app.filas.forEach(c => app.indice.set(c.id, c));
        $("contador").textContent = `${numero(app.conteoTabla.n)} contratos · ${pesos(app.conteoTabla.v)} · mostrando ${numero(app.filas.length)}`;
        $("tablaContratos").innerHTML = app.filas.map(c => filaContrato(c)).join("");
        $("btnMas").style.display = Number(app.conteoTabla.n) > app.filas.length ? "block" : "none";
        return;
      }
    }
    const [lote, conteo] = await Promise.all([
      secop2({ $select: CAMPOS.join(","), $where: where, $order: orden + ", id_contrato", $limit: FILAS_TABLA, $offset: app.filas.length }),
      desdeCero ? secop2({ $select: "count(id_contrato) as n, sum(valor_del_contrato) as v", $where: where }) : null
    ]);
    if (turno !== turnoTabla) return;
    if (conteo) app.conteoTabla = conteo[0] || { n: 0, v: 0 };

    const nuevos = lote.map(prepararSecop2);
    nuevos.forEach(c => app.indice.set(c.id, c));
    app.filas = app.filas.concat(nuevos);

    const total = Number(app.conteoTabla?.n) || 0;
    $("contador").textContent = `${numero(total)} contratos · ${pesos(app.conteoTabla?.v)} · mostrando ${numero(app.filas.length)}`;
    $("tablaContratos").innerHTML = app.filas.map(c => filaContrato(c)).join("") ||
      `<tr><td colspan="8">No hay contratos con estos filtros.</td></tr>`;
    $("btnMas").style.display = total > app.filas.length ? "block" : "none";
  } catch (error) {
    console.error(error);
    if (turno === turnoTabla) $("contador").textContent = "No se pudieron cargar los contratos. Intenta de nuevo.";
  } finally {
    $("btnMas").disabled = false;
  }
}

// ===== 10. BUSCADOR SECOP I Y II (todos los años) =====

function prepararIntegrado(c, i) {
  const numeroContrato = c.numero_del_contrato || c.numero_de_proceso || "Sin número";
  return {
    id: "busq-" + i + "-" + numeroContrato,
    referencia: numeroContrato,
    entidad: c.nombre_de_la_entidad || "Sin dato",
    contratista: c.nom_raz_social_contratista || "Sin dato",
    tipo: clasificarTipo(c.tipo_documento_proveedor),
    objeto: c.objeto_a_contratar || c.objeto_del_proceso || "",
    tipoContrato: c.tipo_de_contrato || "Sin dato",
    modalidad: c.modalidad_de_contrataci_n || "Sin dato",
    valor: Number(c.valor_contrato) || 0,
    pagado: null,
    firma: c.fecha_de_firma_del_contrato || "",
    inicio: c.fecha_inicio_ejecuci_n || "",
    fin: c.fecha_fin_ejecuci_n || "",
    estado: clasificarEstado(c.estado_del_proceso),
    estadoOriginal: c.estado_del_proceso || "",
    diasAdicionados: null,
    origen: c.origen === "SECOPI" ? "SECOP I" : c.origen === "SECOPII" ? "SECOP II" : (c.origen || "SECOP"),
    url: c.url_contrato || ""
  };
}

function condicionBusqueda(tipo, texto) {
  if (tipo === "documento") {
    const num = texto.replace(/\D/g, "");
    if (num.length < 5) throw new Error("Escribe la cédula o NIT completo (solo números).");
    const opciones = [num];
    if (num.length === 10 && /^[89]/.test(num)) opciones.push(num.slice(0, 9)); // NIT escrito con dígito de verificación
    return "(" + opciones.map(n => `documento_proveedor = '${n}' OR documento_proveedor like '${n}-%'`).join(" OR ") + ")";
  }
  const t = textoConsulta(texto);
  if (t.length < 3) throw new Error("Escribe al menos 3 letras.");
  if (tipo === "contrato") return `(upper(numero_del_contrato) like '%${t}%' OR upper(numero_de_proceso) like '%${t}%')`;
  if (tipo === "objeto") return `upper(objeto_a_contratar) like '%${t}%'`;
  return `upper(nom_raz_social_contratista) like '%${t}%'`;
}

async function buscarEnSecop(evento) {
  evento.preventDefault();
  const tipo = $("tipoBusqueda").value;
  const texto = $("textoBusqueda").value;
  const alcance = $("alcanceBusqueda").value;

  let filtro;
  try { filtro = condicionBusqueda(tipo, texto); }
  catch (error) { $("resultadoBusquedaInfo").textContent = error.message; return; }

  if (alcance === "barranca") {
    filtro += ` AND (municipio_entidad = 'Barrancabermeja' OR ${NITS_EXTRA.map(n => `nit_de_la_entidad like '${n}%'`).join(" OR ")})`;
  }

  // Si había una búsqueda en curso, se cancela y se empieza la nueva
  if (app.busqueda) app.busqueda.abort();
  const control = new AbortController();
  app.busqueda = control;

  $("btnBuscar").textContent = "Buscando…";
  $("resumenBusqueda").hidden = true;
  $("contenedorResultados").hidden = true;
  $("tablaResultados").innerHTML = "";
  $("resultadoBusquedaInfo").textContent = alcance === "colombia"
    ? `Buscando «${texto.trim()}» en todo el país… puede tardar hasta un minuto.`
    : `Buscando «${texto.trim()}» en SECOP I y SECOP II…`;

  try {
    const p = new URLSearchParams({ $select: CAMPOS_INTEGRADO.join(","), $where: filtro, $order: "fecha_de_firma_del_contrato DESC", $limit: 1000 });
    const crudos = await consultar(`${API_INTEGRADO}?${p}`, 2, control.signal);
    if (app.busqueda !== control) return;

    // Si un contrato aparece varias veces (por modificaciones), se deja la versión de mayor valor
    const unicos = new Map();
    crudos.map(prepararIntegrado).forEach(c => {
      const clave = c.origen + "|" + c.referencia + "|" + c.entidad;
      const previo = unicos.get(clave);
      if (!previo || c.valor > previo.valor) unicos.set(clave, c);
    });
    const resultados = [...unicos.values()];
    resultados.forEach(c => app.indice.set(c.id, c));
    pintarResultados(resultados, crudos.length >= 1000);
  } catch (error) {
    if (error.name === "AbortError") return; // se canceló porque empezaste otra búsqueda
    console.error(error);
    $("resultadoBusquedaInfo").textContent = "SECOP tardó demasiado o no respondió. Intenta de nuevo o escribe un dato más completo.";
  } finally {
    if (app.busqueda === control) {
      app.busqueda = null;
      $("btnBuscar").textContent = "Buscar";
    }
  }
}

function pintarResultados(lista, recortado) {
  const total = lista.reduce((s, c) => s + c.valor, 0);
  const entidades = new Set(lista.map(c => c.entidad)).size;
  const secop1 = lista.filter(c => c.origen === "SECOP I").length;

  $("resultadoBusquedaInfo").textContent = lista.length
    ? `${numero(lista.length)} contratos encontrados${recortado ? " (se muestran los 1.000 más recientes; escribe un dato más específico para afinar)" : ""}. Haz clic en uno para ver su ficha.`
    : "No se encontraron contratos. Prueba sin tildes, con menos palabras o con «Toda Colombia».";

  $("resumenBusqueda").hidden = !lista.length;
  $("resumenBusqueda").innerHTML = `
    <div><span>Contratos</span><strong>${numero(lista.length)}</strong></div>
    <div><span>Valor total</span><strong>${pesosCorto(total)}</strong></div>
    <div><span>Entidades</span><strong>${numero(entidades)}</strong></div>
    <div><span>SECOP I / SECOP II</span><strong>${numero(secop1)} / ${numero(lista.length - secop1)}</strong></div>`;

  $("contenedorResultados").hidden = !lista.length;
  $("tablaResultados").innerHTML = lista.map(c => filaContrato(c, true)).join("");
}

// ===== 11. FICHA DEL CONTRATO =====

async function abrirFicha(id) {
  let c = app.indice.get(id);
  if (!c) {
    // Contrato que no está en memoria (por ejemplo, desde Secretarías): se pide a SECOP
    try {
      const [r] = await secop2({ $select: CAMPOS.join(","), $where: `id_contrato = ${literal(id)}`, $limit: 1 });
      if (r) { c = prepararSecop2(r); app.indice.set(c.id, c); }
    } catch { /* sin datos */ }
    if (!c) { alert("No se pudo abrir este contrato. Intenta de nuevo."); return; }
  }

  const dato = (titulo, valor, completo = false) =>
    `<div class="${completo ? "completo" : ""}"><span>${titulo}</span>${escapar(valor == null || valor === "" ? "Sin dato" : valor)}</div>`;

  $("fichaContenido").innerHTML = `
    <span class="etiqueta ${claseEstado(c.estado)}">${escapar(c.estado)}</span>
    <span class="etiqueta">${escapar(c.origen)}</span>
    <h3 class="ficha-titulo">${escapar(c.referencia)}</h3>
    <div class="ficha-grid">
      ${dato("Objeto del contrato", c.objeto, true)}
      ${dato("Entidad contratante", c.entidad)}
      ${dato("Contratista", c.contratista)}
      ${dato("Tipo de contratista", c.tipo)}
      ${dato("Tipo de contrato", c.tipoContrato)}
      ${dato("Modalidad", c.modalidad)}
      ${dato("Valor del contrato", pesos(c.valor))}
      ${c.pagado != null ? dato("Valor pagado reportado", `${pesos(c.pagado)} (${porcentaje(c.pagado, c.valor)})`) : ""}
      ${dato("Fecha de firma", fecha(c.firma))}
      ${dato("Fecha de inicio", fecha(c.inicio))}
      ${dato("Fecha de terminación", fecha(c.fin))}
      ${c.diasAdicionados != null ? dato("Días adicionados", c.diasAdicionados) : ""}
      ${dato("Estado reportado", c.estadoOriginal)}
    </div>
    <p id="fichaEnlace" class="ficha-enlace-zona">${c.url ? enlaceSecop(c.url) : "Buscando enlace oficial…"}</p>
    <div class="acciones"><button class="boton-secundario" data-perfil="${escapar(c.contratista)}">👤 Ver perfil de ${escapar(recortar(c.contratista, 40))}</button></div>`;
  $("ficha").showModal();

  // El enlace a SECOP se pide solo cuando se abre la ficha (así la tabla carga más rápido)
  if (!c.url && c.origen === "SECOP II") {
    try {
      const [r] = await secop2({ $select: "urlproceso", $where: `id_contrato = ${literal(c.id)}`, $limit: 1 });
      c.url = r?.urlproceso?.url || "";
    } catch { /* sin enlace */ }
    if ($("fichaEnlace")) $("fichaEnlace").innerHTML = c.url ? enlaceSecop(c.url) : "No se encontró el enlace en SECOP.";
  }
}

// Botón pequeño para abrir el contrato en la página oficial de SECOP
const botonSecop = url => /^https?:\/\//.test(url || "")
  ? `<a class="boton-secop" href="${escapar(url)}" target="_blank" rel="noopener" title="Abrir en la página oficial de SECOP">Ver en SECOP ↗</a>`
  : `<span class="nota-pequena">—</span>`;

const enlaceSecop = url => /^https?:\/\//.test(url)
  ? `<a class="ficha-enlace" href="${escapar(url)}" target="_blank" rel="noopener">Ver registro oficial en SECOP ↗</a>` : "";

// Abre un contrato en SECOP cuando el enlace todavía no se conoce (lo busca primero)
async function abrirEnSecop(id, boton) {
  const ventana = window.open("", "_blank"); // se abre ya para que el navegador no la bloquee
  boton.textContent = "Abriendo…";
  try {
    const [r] = await secop2({ $select: "urlproceso", $where: `id_contrato = ${literal(id)}`, $limit: 1 });
    const url = r?.urlproceso?.url;
    if (url && /^https?:\/\//.test(url)) { if (ventana) ventana.location = url; else window.open(url, "_blank"); }
    else { if (ventana) ventana.close(); alert("No se encontró el enlace de este contrato en SECOP."); }
  } catch {
    if (ventana) ventana.close();
    alert("SECOP no respondió. Intenta de nuevo.");
  } finally {
    boton.textContent = "Ver en SECOP ↗";
  }
}

// ===== PERFIL DEL CONTRATISTA =====
// Todo lo que ha contratado una persona o empresa con las entidades de Barrancabermeja (SECOP II)

async function abrirPerfil(nombre) {
  if (!nombre || nombre === "Sin dato") return;
  if ($("ficha").open) $("ficha").close();
  $("perfilContenido").innerHTML = `<h2>${escapar(nombre)}</h2><p class="info-busqueda">Consultando su historial en SECOP…</p>`;
  $("perfil").showModal();

  const where = `${BASE} AND proveedor_adjudicado = ${literal(nombre)}`;
  try {
    // Una sola consulta: se traen sus contratos y las cifras se calculan aquí (mucho más rápido)
    const lista = await secop2({ $select: CAMPOS.join(","), $where: where, $order: "fecha_de_firma DESC", $limit: 5000 });
    if (!$("perfil").open) return;
    const contratos = lista.map(prepararSecop2);
    contratos.forEach(c => app.indice.set(c.id, c));

    const n = contratos.length;
    const v = contratos.reduce((s, c) => s + c.valor, 0);
    const fechas = contratos.map(c => c.firma).filter(Boolean).sort();
    const r = {
      doc: lista.find(c => c.tipodocproveedor)?.tipodocproveedor,
      p: contratos.reduce((s, c) => s + c.pagado, 0),
      ej: contratos.filter(c => c.estado === "En ejecución").length,
      dir: contratos.filter(c => c.modalidad === "Contratación directa").length,
      desde: fechas[0] || "", hasta: fechas[fechas.length - 1] || ""
    };
    const agruparPor = fn => {
      const g = {};
      contratos.forEach(c => { const k = fn(c); if (!g[k]) g[k] = { k, n: 0, v: 0 }; g[k].n++; g[k].v += c.valor; });
      return Object.values(g);
    };
    const anios = agruparPor(c => c.firma.slice(0, 4)).filter(x => x.k).sort((a, b) => a.k.localeCompare(b.k));
    const entidades = agruparPor(c => c.entidad).sort((a, b) => b.v - a.v);
    const visibles = contratos.slice(0, 300);
    const anioDesde = (r.desde || "").slice(0, 4), anioHasta = (r.hasta || "").slice(0, 4);
    const aniosActivos = anios.length;

    $("perfilContenido").innerHTML = `
      <span class="etiqueta">${clasificarTipo(r.doc)}</span>
      <h2>${escapar(nombre)}</h2>
      <p class="nota-pequena">Contratos con entidades públicas de Barrancabermeja registrados en SECOP II. No se muestra su número de documento.</p>
      <div class="detalle-cifras">
        <div><span>Valor contratado</span><b>${pesosCorto(v)}</b></div>
        <div><span>Contratos</span><b>${numero(n)}</b></div>
        <div><span>Promedio por contrato</span><b>${pesosCorto(n ? v / n : 0)}</b></div>
        <div><span>Años activo</span><b>${numero(aniosActivos)}</b>${anioDesde ? `<span>${anioDesde}–${anioHasta}</span>` : ""}</div>
        <div><span>En ejecución hoy</span><b>${numero(r.ej)}</b></div>
        <div><span>Contratación directa</span><b>${porcentaje(Number(r.dir), n)}</b></div>
        <div><span>Pagos reportados</span><b>${porcentaje(Number(r.p) || 0, v)}</b></div>
      </div>
      <div class="detalle-columnas">
        <div>
          <h3>Valor contratado por año</h3>
          <div class="lienzo"><canvas id="gPerfil"></canvas></div>
        </div>
        <div>
          <h3>Entidades que lo han contratado</h3>
          <div class="tabla-contenedor"><table>
            <thead><tr><th>Entidad</th><th>Contratos</th><th>Valor</th><th>%</th></tr></thead>
            <tbody>${entidades.map(e => `<tr><td>${escapar(e.k || "Sin dato")}</td><td class="num">${numero(e.n)}</td>
              <td class="valor">${pesosCorto(e.v)}</td><td class="num">${porcentaje(Number(e.v), v)}</td></tr>`).join("")}</tbody>
          </table></div>
        </div>
      </div>
      <h3>Sus contratos${n > visibles.length ? ` (los ${numero(visibles.length)} más recientes)` : ""}</h3>
      <div class="tabla-contenedor"><table>
        <thead><tr><th>Firma</th><th>Contrato</th><th>Entidad</th><th>Objeto</th><th>Estado</th><th>Valor</th><th>Página oficial</th></tr></thead>
        <tbody>${visibles.map(c => `
          <tr class="clic" data-id="${escapar(c.id)}">
            <td>${fecha(c.firma)}</td><td>${escapar(c.referencia)}</td><td>${escapar(recortar(c.entidad, 40))}</td>
            <td class="objeto">${escapar(recortar(c.objeto, 100))}</td>
            <td><span class="etiqueta ${claseEstado(c.estado)}">${escapar(c.estado)}</span></td>
            <td class="valor">${pesos(c.valor)}</td><td>${botonSecop(c.url)}</td>
          </tr>`).join("") || `<tr><td colspan="7">No se encontraron contratos con entidades de Barrancabermeja.</td></tr>`}</tbody>
      </table></div>
      <div class="acciones">
        <button id="btnPerfilColombia" data-nombre="${escapar(nombre)}">🔎 Buscar en toda Colombia (SECOP I y II)</button>
      </div>`;

    if (typeof Chart !== "undefined") {
      const filas = anios;
      dibujar("gPerfil", {
        type: "bar",
        data: { labels: filas.map(a => a.k), datasets: [{ data: filas.map(a => (Number(a.v) || 0) / 1e6), backgroundColor: color("--verde-claro"), borderRadius: 8 }] },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => " " + pesosCorto(ctx.raw * 1e6) } } } }
      });
    }
  } catch (error) {
    console.error(error);
    $("perfilContenido").innerHTML = `<h2>${escapar(nombre)}</h2><p>SECOP no respondió. Intenta de nuevo en un momento.</p>`;
  }
}

// ===== 12. EXPORTAR Y ARRANQUE =====

// La herramienta de Excel (casi 1 MB) solo se descarga cuando alguien la necesita
function cargarHerramientaExcel() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  return new Promise((ok, falla) => {
    const script = document.createElement("script");
    script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    script.onload = ok;
    script.onerror = () => falla(new Error("No se pudo cargar la herramienta de Excel"));
    document.head.appendChild(script);
  });
}

async function descargarExcel() {
  const boton = $("btnExcel");
  boton.disabled = true;
  boton.textContent = "Preparando Excel…";
  try {
    await cargarHerramientaExcel();
    const orden = $("ordenContratos").value === "valor" ? "valor_del_contrato DESC" : "fecha_de_firma DESC";
    const datos = (await secop2({ $select: CAMPOS.join(","), $where: condicionCompleta(), $order: orden, $limit: 50000 })).map(prepararSecop2);
    const filas = datos.map(c => ({
      "Identificador SECOP": c.id, "Número de contrato": c.referencia,
      "Fecha de firma": fecha(c.firma), "Fecha de inicio": fecha(c.inicio), "Fecha de terminación": fecha(c.fin),
      "Entidad": c.entidad, "Contratista": c.contratista, "Tipo de contratista": c.tipo,
      "Objeto": c.objeto, "Tipo de contrato": c.tipoContrato, "Modalidad": c.modalidad,
      "Estado": c.estado, "Valor": c.valor, "Valor pagado reportado": c.pagado,
      "Enlace SECOP": c.url
    }));
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), "Contratos");
    XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet([
      ["Fuente", "SECOP II - datos.gov.co (conjunto jbjy-vk9h)"],
      ["Consulta", new Date().toLocaleString("es-CO")],
      ["Periodo", $("anio").value || "Todos los años"],
      ["Contratos en el archivo", filas.length],
      ["Elaborado con", "Transparencia Barrancabermeja · Iván Rodríguez, Edil de la Comuna 5"],
      ["Aviso", "Iniciativa ciudadana. Cifras indicativas según lo reportado por las entidades en SECOP II."]
    ]), "Fuente");
    XLSX.writeFile(libro, `contratos-barrancabermeja-${$("anio").value || "todos"}-${hoyISO()}.xlsx`);
  } catch (error) {
    console.error(error);
    alert("No se pudo preparar el Excel. Intenta de nuevo o pon más filtros.");
  } finally {
    boton.disabled = false;
    boton.textContent = "Descargar Excel";
  }
}

function iniciar() {
  $("anio").add(new Option("Todos los años", ""));
  for (let a = new Date().getFullYear(); a >= PRIMER_ANIO; a--) $("anio").add(new Option(a, a));

  // Pestañas y enlaces internos
  document.querySelectorAll(".pestana-btn").forEach(b => b.addEventListener("click", () => irA(b.dataset.tab)));
  document.addEventListener("click", e => {
    const enlace = e.target.closest("[data-ir]");
    if (enlace) irA(enlace.dataset.ir);
  });

  // Filtros
  $("buscador").addEventListener("input", aplicarFiltros);
  ["filtroEntidad", "filtroModalidad", "filtroEstado", "filtroTipo", "anio"].forEach(id => $(id).addEventListener("change", aplicarFiltros));
  $("btnLimpiar").addEventListener("click", limpiarFiltros);
  $("btnQuitarVista").addEventListener("click", () => { app.vista = null; aplicarFiltros(); });
  $("ordenContratos").addEventListener("change", () => pintarContratos(true));

  // Botones
  $("btnExcel").addEventListener("click", descargarExcel);
  $("btnImprimir").addEventListener("click", () => window.print());
  $("btnMas").addEventListener("click", () => pintarContratos(false));
  $("btnCerrarFicha").addEventListener("click", () => $("ficha").close());
  $("formBuscar").addEventListener("submit", buscarEnSecop);

  // Buscador grande de la portada: detecta solo si escribiste un número o un nombre
  $("formPortada").addEventListener("submit", e => {
    e.preventDefault();
    const texto = $("textoPortada").value.trim();
    const soloNumeros = /^[\d.\s]+$/.test(texto) || /^[\d.]{9,11}-\d$/.test(texto); // cédula, o NIT con dígito de verificación
    const pareceContrato = /\d/.test(texto) && texto.length < 30;
    $("tipoBusqueda").value = soloNumeros ? "documento" : pareceContrato ? "contrato" : "nombre";
    $("textoBusqueda").value = texto;
    $("alcanceBusqueda").value = "barranca";
    irA("buscar");
    $("formBuscar").requestSubmit();
  });
  $("tipoBusqueda").addEventListener("change", () => {
    const ejemplos = { nombre: "Ej: Aseos y Servicios de Colombia", documento: "Ej: 900346265 (solo números)",
                       contrato: "Ej: 5361-26", objeto: "Ej: pavimentación" };
    $("textoBusqueda").placeholder = ejemplos[$("tipoBusqueda").value];
  });

  // Cualquier nombre de contratista abre su perfil
  document.addEventListener("click", e => {
    const p = e.target.closest("[data-perfil]");
    if (p) { e.stopPropagation(); abrirPerfil(p.dataset.perfil); }
  }, true);
  $("btnCerrarPerfil").addEventListener("click", () => $("perfil").close());
  $("perfilContenido").addEventListener("click", e => {
    if (e.target.closest("a")) return;
    if (e.target.id === "btnPerfilColombia") {
      $("perfil").close();
      $("tipoBusqueda").value = "nombre";
      $("textoBusqueda").value = e.target.dataset.nombre;
      $("alcanceBusqueda").value = "colombia";
      irA("buscar");
      $("formBuscar").requestSubmit();
      return;
    }
    const f = e.target.closest("tr[data-id]");
    if (f) abrirFicha(f.dataset.id);
  });

  // Clics en tarjetas y tablas
  $("listaAlertas").addEventListener("click", e => {
    const t = e.target.closest("[data-alerta]");
    if (!t) return;
    app.vista = t.dataset.alerta;
    aplicarFiltros();
    irA("contratos");
  });
  $("tarjetasEntidades").addEventListener("click", e => {
    const t = e.target.closest("[data-entidad]");
    if (!t) return;
    $("filtroEntidad").value = t.dataset.entidad;
    aplicarFiltros();
    irA("contratos");
  });
  $("tablaContratistas").addEventListener("click", e => {
    const f = e.target.closest("tr[data-contratista]");
    if (f) abrirPerfil(f.dataset.contratista);
  });
  $("tarjetasSecretarias").addEventListener("click", e => {
    const t = e.target.closest("[data-secretaria]");
    if (t) verSecretaria(Number(t.dataset.secretaria));
  });
  $("detalleSecretaria").addEventListener("click", e => {
    if (e.target.id === "btnCerrarSecretaria") { $("detalleSecretaria").hidden = true; return; }
    if (e.target.closest("a")) return;
    const abrir = e.target.closest("[data-abrir-secop]");
    if (abrir) { abrirEnSecop(abrir.dataset.abrirSecop, abrir); return; }
    const contrato = e.target.closest("tr[data-id]");
    if (contrato) { abrirFicha(contrato.dataset.id); return; }
    const contratista = e.target.closest("tr[data-contratista]");
    if (contratista) abrirPerfil(contratista.dataset.contratista);
  });
  ["tablaContratos", "tablaResultados"].forEach(id => $(id).addEventListener("click", e => {
    if (e.target.closest("a")) return; // el botón «Ver en SECOP» abre la página oficial, no la ficha
    const f = e.target.closest("tr[data-id]");
    if (f) abrirFicha(f.dataset.id);
  }));

  // Abrir la pestaña que venga en el enlace (por ejemplo …vercel.app/#buscar)
  const inicial = location.hash.replace("#", "");
  if (document.querySelector(`.pestana[data-tab="${inicial}"]`)) irA(inicial);

  if (!document.body.dataset.pestana) document.body.dataset.pestana = "inicio";
  cargarTablero();
  cargarAlertas();
}

iniciar();
