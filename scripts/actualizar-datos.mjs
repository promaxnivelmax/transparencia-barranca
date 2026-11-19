/* =========================================================
   TRANSPARENCIA BARRANCABERMEJA · Generador del resumen
   Creado por Iván Rodríguez

   Este programa consulta SECOP, calcula el resumen de TODOS los años
   y lo guarda en datos/resumen.json. La página lee ese archivo al
   abrir, por eso carga al instante.

   También une los contratos de la Alcaldía con sus procesos para
   saber qué SECRETARÍA o DEPENDENCIA hizo cada contrato.

   Se ejecuta solo todos los días con GitHub Actions
   (.github/workflows/actualizar-datos.yml). También puedes
   correrlo a mano con:  node scripts/actualizar-datos.mjs
   ========================================================= */

import { writeFile, mkdir, rm } from "node:fs/promises";

const API_CONTRATOS = "https://www.datos.gov.co/resource/jbjy-vk9h.json";
const API_PROCESOS = "https://www.datos.gov.co/resource/p6dx-8zbt.json";
const NIT_ALCALDIA = "890201900";
const NITS_EXTRA = [
  "890201900",  // Alcaldía Distrital de Barrancabermeja
  "829001846",  // Empresa Social del Estado (E.S.E.) Barrancabermeja
  "800024581",  // Instituto Universitario de la Paz (UNIPAZ)
  "8000160643", // Institución Educativa Diego Hernández de Gallegos
  "900112222",  // Institución Educativa Los Laureles
  "829003831"   // Ministerio del Trabajo - Oficina Especial Barrancabermeja
];
const BASE = `(ciudad = 'Barrancabermeja' OR nit_entidad in (${NITS_EXTRA.map(n => `'${n}'`).join(",")}))`;
const DOCS_PERSONA = ["Cédula de Ciudadanía", "Cédula de Extranjería", "Pasaporte", "Permiso por Protección Temporal"];

const esperar = ms => new Promise(r => setTimeout(r, ms));
const literal = v => `'${String(v).replace(/'/g, "''")}'`;
const hoyISO = (dias = 0) => new Date(Date.now() + dias * 864e5).toISOString().slice(0, 10);

async function consultar(api, parametros, intentos = 4) {
  const url = `${api}?${new URLSearchParams(parametros)}`;
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Error ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (error) {
      console.log(`  Intento ${i} falló: ${error.message}`);
      if (i === intentos) throw error;
      await esperar(3000 * i);
    }
  }
}

// Descarga todos los registros, de a 50.000
async function descargarTodo(api, parametros) {
  const todos = [];
  for (let desde = 0; ; desde += 50000) {
    const lote = await consultar(api, { ...parametros, $limit: 50000, $offset: desde, $order: ":id" });
    todos.push(...lote);
    if (lote.length < 50000) return todos;
  }
}

// ---------- 1. Resumen del tablero (mismas consultas que usa la página) ----------

async function resumenTablero() {
  const w = BASE;
  const sumaSi = (cond, nombre) => `sum(case(${cond}, 1, true, 0)) as ${nombre}`;
  const consultas = {
    resumen: { $select: "count(id_contrato) as n, sum(valor_del_contrato) as v, sum(valor_pagado) as p, count(distinct proveedor_adjudicado) as c", $where: w },
    modalidades: { $select: "modalidad_de_contratacion as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: w, $group: "modalidad_de_contratacion", $order: "n DESC" },
    estados: { $select: "estado_contrato as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: w, $group: "estado_contrato", $order: "n DESC" },
    documentos: { $select: "tipodocproveedor as k, count(id_contrato) as n, sum(valor_del_contrato) as v, count(distinct proveedor_adjudicado) as c", $where: w, $group: "tipodocproveedor" },
    entidades: { $select: `nombre_entidad as k, count(id_contrato) as n, sum(valor_del_contrato) as v, ${sumaSi("estado_contrato = 'En ejecución'", "ej")}, ${sumaSi("modalidad_de_contratacion = 'Contratación directa'", "dir")}`,
                 $where: w, $group: "nombre_entidad", $order: "v DESC", $limit: 200 },
    tiempo: { $select: "date_extract_y(fecha_de_firma) as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: w, $group: "k", $order: "k" },
    tiposContrato: { $select: "tipo_de_contrato as k, count(id_contrato) as n, sum(valor_del_contrato) as v", $where: w, $group: "tipo_de_contrato", $order: "v DESC", $limit: 8 },
    contratistas: { $select: `proveedor_adjudicado as k, max(tipodocproveedor) as doc, count(id_contrato) as n, sum(valor_del_contrato) as v, ${sumaSi("estado_contrato = 'En ejecución'", "ej")}, count(distinct nombre_entidad) as e`,
                    $where: w, $group: "proveedor_adjudicado", $order: "v DESC", $limit: 50 }
  };
  consultas.tabla = { $select: "id_contrato, referencia_del_contrato, nombre_entidad, proveedor_adjudicado, tipodocproveedor, valor_del_contrato, valor_pagado, fecha_de_firma, fecha_de_inicio_del_contrato, fecha_de_fin_del_contrato, objeto_del_contrato, modalidad_de_contratacion, tipo_de_contrato, estado_contrato, dias_adicionados, urlproceso",
                      $where: `${w} AND fecha_de_firma IS NOT NULL`, $order: "fecha_de_firma DESC, id_contrato", $limit: 100 };
  consultas.tablaConteo = { $select: "count(id_contrato) as n, sum(valor_del_contrato) as v", $where: `${w} AND fecha_de_firma IS NOT NULL` };
  const datos = {};
  for (const [nombre, parametros] of Object.entries(consultas)) {
    console.log("  Consultando", nombre);
    datos[nombre] = await consultar(API_CONTRATOS, parametros);
  }
  return datos;
}

// ---------- 2. Alertas (mismas reglas que la página) ----------

async function resumenAlertas() {
  const hoy = hoyISO(), en30 = hoyISO(30), hace90 = hoyISO(-90);
  const muchos = (await consultar(API_CONTRATOS, {
    $select: "proveedor_adjudicado as k, count(id_contrato) as n",
    $where: `${BASE} AND estado_contrato = 'En ejecución'`,
    $group: "proveedor_adjudicado", $having: "n >= 5", $order: "n DESC", $limit: 300
  })).map(m => m.k).filter(Boolean);

  const condiciones = {
    directaGrande: `modalidad_de_contratacion = 'Contratación directa' AND valor_del_contrato >= 500000000`,
    muyGrandes: `valor_del_contrato >= 10000000000`,
    vencidos: `estado_contrato = 'En ejecución' AND fecha_de_fin_del_contrato < '${hoy}T00:00:00'`,
    vencenPronto: `estado_contrato = 'En ejecución' AND fecha_de_fin_del_contrato >= '${hoy}T00:00:00' AND fecha_de_fin_del_contrato <= '${en30}T23:59:59'`,
    muchosContratos: muchos.length ? `estado_contrato = 'En ejecución' AND proveedor_adjudicado in (${muchos.map(literal).join(",")})` : "1 = 0",
    sinPagos: `estado_contrato = 'En ejecución' AND valor_pagado = 0 AND valor_del_contrato > 0 AND fecha_de_inicio_del_contrato < '${hace90}T00:00:00'`
  };
  const conteos = {};
  for (const [id, cond] of Object.entries(condiciones)) {
    console.log("  Alerta", id);
    const [r] = cond === "1 = 0" ? [{ n: 0, v: 0 }] :
      await consultar(API_CONTRATOS, { $select: "count(id_contrato) as n, sum(valor_del_contrato) as v", $where: `${BASE} AND (${cond})` });
    conteos[id] = { n: Number(r?.n) || 0, valor: Number(r?.v) || 0 };
  }
  return { muchos, conteos, fechaReglas: hoy };
}

// ---------- 3. Secretarías y dependencias de la Alcaldía ----------

// Une nombres que son la misma dependencia escrita de formas distintas
function claveUnidad(nombre) {
  return (nombre || "SIN DEPENDENCIA").toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(p => p && !["SECRETARIA", "DISTRITAL", "DIRECCION", "GERENCIA", "OFICINA", "UNIDAD", "CONTRATACION",
                         "DE", "DEL", "LA", "LAS", "LOS", "Y", "E", "EL"].includes(p))
    .join(" ") || "SIN DEPENDENCIA";
}

async function resumenSecretarias() {
  console.log("  Descargando procesos de la Alcaldía…");
  const procesos = await descargarTodo(API_PROCESOS, {
    $select: "id_del_portafolio, nombre_de_la_unidad_de", $where: `nit_entidad = '${NIT_ALCALDIA}'`
  });
  const unidadDeProceso = new Map(procesos.map(p => [p.id_del_portafolio, p.nombre_de_la_unidad_de]));
  console.log(`  ${procesos.length} procesos`);

  console.log("  Descargando contratos de la Alcaldía…");
  const contratos = await descargarTodo(API_CONTRATOS, {
    $select: "id_contrato, referencia_del_contrato, proceso_de_compra, proveedor_adjudicado, tipodocproveedor, valor_del_contrato, estado_contrato, modalidad_de_contratacion, fecha_de_firma, objeto_del_contrato, urlproceso",
    $where: `nit_entidad = '${NIT_ALCALDIA}'`
  });
  console.log(`  ${contratos.length} contratos`);

  const unidades = new Map();
  let sinUnidad = 0;
  for (const c of contratos) {
    const nombreOriginal = unidadDeProceso.get(c.proceso_de_compra);
    if (!nombreOriginal) sinUnidad++;
    const clave = claveUnidad(nombreOriginal);
    if (!unidades.has(clave)) unidades.set(clave, { nombres: {}, n: 0, v: 0, ej: 0, dir: 0, anios: {}, contratistas: new Map(), contratos: [] });
    const u = unidades.get(clave);
    const valor = Number(c.valor_del_contrato) || 0;
    const nombre = nombreOriginal || "Sin dependencia identificada";
    u.nombres[nombre] = (u.nombres[nombre] || 0) + 1;
    u.n++; u.v += valor;
    if (c.estado_contrato === "En ejecución") u.ej++;
    if (c.modalidad_de_contratacion === "Contratación directa") u.dir++;
    const anio = (c.fecha_de_firma || "").slice(0, 4) || "Sin fecha";
    u.anios[anio] = (u.anios[anio] || 0) + valor;

    const prov = c.proveedor_adjudicado || "Sin dato";
    const k = u.contratistas.get(prov) || { k: prov, empresa: c.tipodocproveedor === "NIT", n: 0, v: 0 };
    k.n++; k.v += valor;
    u.contratistas.set(prov, k);

    u.contratos.push({
      id: c.id_contrato, ref: c.referencia_del_contrato || c.id_contrato, prov, v: valor,
      f: (c.fecha_de_firma || "").slice(0, 10), est: c.estado_contrato || "",
      obj: (c.objeto_del_contrato || "").slice(0, 140),
      u: c.urlproceso?.url || ""
    });
  }

  const lista = [...unidades.values()].map(u => {
    const nombre = Object.entries(u.nombres).sort((a, b) => b[1] - a[1])[0][0];
    const otrosNombres = Object.keys(u.nombres).filter(x => x !== nombre);
    return {
      nombre, otrosNombres, n: u.n, v: u.v, ej: u.ej, dir: u.dir,
      anios: Object.entries(u.anios).sort((a, b) => a[0].localeCompare(b[0])),
      contratistas: [...u.contratistas.values()].sort((a, b) => b.v - a.v).slice(0, 15),
      mayores: [...u.contratos].sort((a, b) => b.v - a.v).slice(0, 15),
      recientes: [...u.contratos].sort((a, b) => b.f.localeCompare(a.f)).slice(0, 15),
      // Lista completa (va en un archivo aparte por secretaría; sin enlace para que pese menos)
      todos: [...u.contratos].sort((a, b) => b.f.localeCompare(a.f)).map(({ u: _enlace, ...resto }) => resto)
    };
  }).sort((a, b) => b.v - a.v);

  return { total: contratos.length, sinUnidad, unidades: lista };
}

// ---------- 4. Barranca en datos (Sisbén, desempeño, empresas, votación) ----------

const API = id => `https://www.datos.gov.co/resource/${id}.json`;
const COD_BARRANCA = "68081", COD_BUCARAMANGA = "68001";

async function barrancaEnDatos() {
  // Sisbén IV (DNP): personas estimadas con el factor de expansión, por grupo
  const sisben = {};
  const zonas = { barranca: `cod_mpio = '${COD_BARRANCA}'`, bucaramanga: `cod_mpio = '${COD_BUCARAMANGA}'`,
                  santander: `starts_with(cod_mpio, '68')`, colombia: "1 = 1" };
  for (const [zona, cond] of Object.entries(zonas)) {
    console.log("  Sisbén", zona);
    const filas = await consultar(API("hq2v-5umk"), { $select: "grupo, sum(fex) as p", $where: cond, $group: "grupo", $order: "grupo" });
    sisben[zona] = Object.fromEntries(filas.map(f => [f.grupo, Math.round(Number(f.p))]));
  }
  const corte = (await consultar(API("hq2v-5umk"), { $select: "corte", $group: "corte" })).map(c => c.corte);

  // Medición de Desempeño Municipal (DNP)
  console.log("  Desempeño municipal");
  const mdm = await consultar(API("nkjx-rsq7"), {
    $select: "codigo_entidad, entidad, anio, indicador, dato",
    $where: `codigo_entidad in ('${COD_BARRANCA}','${COD_BUCARAMANGA}') AND indicador in ('MDM','Componente de gestión','Componente de resultados')`,
    $order: "anio", $limit: 500
  });

  // Empresas registradas en la Cámara de Comercio de Barrancabermeja (pymes)
  console.log("  Empresas");
  const tamanos = await consultar(API("ryfe-5k95"), { $select: "tam_empresa as k, count(*) as n", $group: "tam_empresa" });
  const sectores = await consultar(API("ryfe-5k95"), { $select: "ciiu_1 as k, count(*) as n", $group: "ciiu_1", $order: "n DESC", $limit: 10 });

  // Puestos de votación de las elecciones territoriales 2023
  console.log("  Puestos de votación");
  const puestos = await consultar(API("mv2e-prx5"), {
    $select: "puesto, comuna, direccion, latitud, longitud", $where: "municipio = 'BARRANCABERMEJA'", $limit: 500
  });

  return { sisben, corteSisben: corte, mdm, empresas: { tamanos, sectores }, puestos };
}

// ---------- 5. Candidatos 2019 (Cuentas Claras) y su cruce con SECOP ----------

// Dígito de verificación del NIT (método oficial de la DIAN)
function digitoVerificacion(nit) {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const d = String(nit).split("").reverse();
  const suma = d.reduce((s, x, i) => s + Number(x) * pesos[i], 0);
  const r = suma % 11;
  return r > 1 ? 11 - r : r;
}

// Busca en SECOP II los contratos (con entidades de Barrancabermeja) de una lista de documentos
async function contratosPorDocumento(documentos) {
  const variantes = new Map(); // variante del documento → documento original
  for (const doc of documentos) {
    const limpio = String(doc).replace(/\D/g, "");
    if (limpio.length < 5) continue;
    variantes.set(limpio, doc);
    if (limpio.length === 9 && /^[89]/.test(limpio)) variantes.set(limpio + digitoVerificacion(limpio), doc);
  }
  const resultado = {};
  const lista = [...variantes.keys()];
  for (let i = 0; i < lista.length; i += 80) {
    const lote = lista.slice(i, i + 80);
    const filas = await consultar(API_CONTRATOS, {
      $select: "documento_proveedor as d, count(id_contrato) as n, sum(valor_del_contrato) as v, min(fecha_de_firma) as desde, max(fecha_de_firma) as hasta",
      $where: `${BASE} AND documento_proveedor in (${lote.map(literal).join(",")})`,
      $group: "documento_proveedor"
    });
    for (const f of filas) {
      const original = variantes.get(f.d);
      const r = resultado[original] || { n: 0, v: 0, desde: f.desde, hasta: f.hasta };
      r.n += Number(f.n); r.v += Number(f.v);
      if (f.desde < r.desde) r.desde = f.desde;
      if (f.hasta > r.hasta) r.hasta = f.hasta;
      resultado[original] = r;
    }
  }
  return resultado;
}

async function candidatos2019() {
  console.log("  Descargando Cuentas Claras 2019 de Barrancabermeja…");
  const filas = await descargarTodo(API("jgra-rz2t"), {
    $select: "can_identificacion, nombre_candidato, cnd_nombre, org_nombre, nombre_persona, tpe_nombre, ing_identificacion, ing_valor, tdo_nombre",
    $where: "mun_nombre = 'BARRANCABERMEJA'"
  });
  console.log(`  ${filas.length} aportes`);

  const candidatos = new Map();
  for (const f of filas) {
    const id = f.can_identificacion;
    if (!candidatos.has(id)) candidatos.set(id, { id, nombre: f.nombre_candidato, cargo: f.cnd_nombre, partido: f.org_nombre, n: 0, v: 0, aportantes: new Map() });
    const c = candidatos.get(id);
    const valor = (Number(f.ing_valor) || 0) / 100; // Cuentas Claras publica el valor en centavos
    c.n++; c.v += valor;
    if (f.ing_identificacion && f.ing_identificacion !== id && f.ing_identificacion !== "NO APLICA") {
      const a = c.aportantes.get(f.ing_identificacion) || { doc: f.ing_identificacion, nombre: f.nombre_persona, tipo: f.tpe_nombre, v: 0 };
      a.v += valor;
      c.aportantes.set(f.ing_identificacion, a);
    }
  }

  console.log("  Cruzando candidatos y financiadores con SECOP…");
  const docsCandidatos = [...candidatos.keys()];
  const docsAportantes = [...new Set([...candidatos.values()].flatMap(c => [...c.aportantes.keys()]))];
  const [contratosCandidatos, contratosAportantes] = [await contratosPorDocumento(docsCandidatos), await contratosPorDocumento(docsAportantes)];

  // Lista de contratos de cada candidato que tiene contratos
  const listas = {};
  const conContratos = Object.keys(contratosCandidatos);
  const variantes = new Map();
  for (const doc of conContratos) {
    variantes.set(doc, doc);
    if (doc.length === 9 && /^[89]/.test(doc)) variantes.set(doc + digitoVerificacion(doc), doc);
  }
  const todasVariantes = [...variantes.keys()];
  for (let i = 0; i < todasVariantes.length; i += 60) {
    const lote = todasVariantes.slice(i, i + 60);
    const filas = await descargarTodo(API_CONTRATOS, {
      $select: "id_contrato, referencia_del_contrato, nombre_entidad, valor_del_contrato, fecha_de_firma, estado_contrato, objeto_del_contrato, documento_proveedor",
      $where: `${BASE} AND documento_proveedor in (${lote.map(literal).join(",")})`
    });
    for (const f of filas) {
      const original = variantes.get(f.documento_proveedor);
      (listas[original] ||= []).push({
        id: f.id_contrato, ref: f.referencia_del_contrato || f.id_contrato, ent: f.nombre_entidad,
        v: Number(f.valor_del_contrato) || 0, f: (f.fecha_de_firma || "").slice(0, 10),
        est: f.estado_contrato || "", obj: (f.objeto_del_contrato || "").slice(0, 140)
      });
    }
  }
  Object.values(listas).forEach(l => l.sort((a, b) => b.f.localeCompare(a.f)));

  // Se publica SIN números de cédula ni NIT
  return [...candidatos.values()].map(c => ({
    nombre: c.nombre, cargo: c.cargo, partido: c.partido,
    aportes: c.n, ingresos: Math.round(c.v),
    contratos: contratosCandidatos[c.id] || null,
    listaContratos: listas[c.id] || [],
    financiadoresContratistas: [...c.aportantes.values()]
      .filter(a => contratosAportantes[a.doc])
      .map(a => ({ nombre: a.nombre, tipo: a.tipo, aporte: Math.round(a.v), contratos: contratosAportantes[a.doc] }))
      .sort((x, y) => y.contratos.v - x.contratos.v)
  })).sort((a, b) => b.ingresos - a.ingresos);
}

// ---------- Ejecutar todo ----------

console.log("1/5 Resumen del tablero");
const tablero = await resumenTablero();
console.log("2/5 Alertas");
const alertas = await resumenAlertas();
console.log("3/5 Secretarías de la Alcaldía");
const secretarias = await resumenSecretarias();
console.log("4/5 Barranca en datos");
const barranca = await barrancaEnDatos();
console.log("5/5 Candidatos 2019");
const candidatos = await candidatos2019();

await mkdir("datos", { recursive: true });
const fecha = Date.now();
// El resumen principal va liviano para que la página cargue rapidísimo;
// las secretarías van aparte y solo se descargan al abrir esa pestaña.
await writeFile("datos/resumen.json", JSON.stringify({ fecha, tablero, alertas }));
// Cada secretaría tiene su archivo con TODOS sus contratos (se descarga solo al abrirla)
await rm("datos/secretarias", { recursive: true, force: true });
await mkdir("datos/secretarias", { recursive: true });
for (const [i, u] of secretarias.unidades.entries()) {
  await writeFile(`datos/secretarias/${i}.json`, JSON.stringify(u.todos));
  delete u.todos;
}
await writeFile("datos/secretarias.json", JSON.stringify({ fecha, ...secretarias }));
await writeFile("datos/barranca.json", JSON.stringify({ fecha, ...barranca }));
await writeFile("datos/candidatos.json", JSON.stringify({ fecha, eleccion: "Elecciones territoriales 2019", candidatos }));
console.log("Listo: datos/resumen.json");
