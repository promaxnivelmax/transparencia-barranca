"use strict";

/* =========================================================
   TRANSPARENCIA BARRANCABERMEJA · app.js
   1. Configuración
   2. Utilidades
   3. Descarga de datos (con paginación, reintentos y sin duplicados)
   4. Filtros
   5. Indicadores
   6. Gráficos
   7. Tablas (entidades, contratistas, contratos)
   8. Ficha del contrato
   9. Exportar e imprimir
   10. Arranque
   ========================================================= */

// ===== 1. CONFIGURACIÓN =====

const API = "https://www.datos.gov.co/resource/jbjy-vk9h.json";

// Entidades del Distrito que SECOP registra SIN ciudad. Se identifican por su NIT.
// Si encuentras otra entidad en esa situación, agrega su NIT aquí.
const NITS_EXTRA = [
  "890201900" // Alcaldía Distrital de Barrancabermeja
];

// Solo pedimos los campos que usamos. Así la descarga es más liviana
// y NO traemos cédulas, direcciones ni datos bancarios.
const CAMPOS = [
  "id_contrato", "referencia_del_contrato", "nombre_entidad", "nit_entidad",
  "proveedor_adjudicado", "tipodocproveedor", "valor_del_contrato",
  "fecha_de_firma", "fecha_de_inicio_del_contrato", "fecha_de_fin_del_contrato",
  "objeto_del_contrato", "modalidad_de_contratacion", "tipo_de_contrato",
  "estado_contrato", "dias_adicionados", "urlproceso"
];

const POR_PAGINA = 1000;   // registros por consulta a la API
const FILAS_TABLA = 100;   // filas que se muestran cada vez en la tabla

// Traducción de los estados que reporta SECOP a categorías claras
const ESTADOS = {
  "en ejecución": "En ejecución",
  "en ejecucion": "En ejecución",
  "aprobado": "Aprobado, sin iniciar",
  "modificado": "Modificado",
  "cedido": "Cedido",
  "suspendido": "Suspendido",
  "terminado": "Terminado",
  "cerrado": "Cerrado",
  "liquidado": "Liquidado"
};

const DOCS_PERSONA = ["Cédula de Ciudadanía", "Cédula de Extranjería", "Pasaporte", "Permiso por Protección Temporal"];

// Estado de la aplicación (todo lo que cambia mientras se usa la página)
const app = {
  todos: [],
  filtrados: [],
  filasVisibles: FILAS_TABLA,
  graficos: {},
  duplicados: 0,
  consultadoEn: null
};

// ===== 2. UTILIDADES =====

const $ = id => document.getElementById(id);

function pesos(valor) {
  return valor.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
}

// Forma corta y fácil de leer: $ 12,5 mil millones
function pesosCorto(valor) {
  const f = n => n.toLocaleString("es-CO", { maximumFractionDigits: 1 });
  if (valor >= 1e12) return "$ " + f(valor / 1e12) + " billones";
  if (valor >= 1e9) return "$ " + f(valor / 1e9) + " mil millones";
  if (valor >= 1e6) return "$ " + f(valor / 1e6) + " millones";
  return pesos(valor);
}

const numero = n => n.toLocaleString("es-CO");
const porcentaje = (parte, total) => total ? (parte / total * 100).toLocaleString("es-CO", { maximumFractionDigits: 1 }) + " %" : "0 %";

// Seguridad: evita que un texto de los datos se ejecute como código HTML
function escapar(texto) {
  const div = document.createElement("div");
  div.textContent = texto == null ? "" : String(texto);
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fecha(texto) {
  return texto ? texto.slice(0, 10) : "Sin dato";
}

function clasificarEstado(estado) {
  const clave = (estado || "").trim().toLowerCase();
  if (!clave) return "Sin información";
  return ESTADOS[clave] || estado;
}

function clasificarTipo(tipoDocumento) {
  if (tipoDocumento === "NIT") return "Empresa";
  if (DOCS_PERSONA.includes(tipoDocumento)) return "Persona natural";
  return "Sin clasificar";
}

function claseEstado(estado) {
  if (estado === "En ejecución") return "ejecucion";
  if (["Terminado", "Cerrado", "Liquidado"].includes(estado)) return "terminado";
  if (estado === "Modificado") return "modificado";
  if (["Suspendido", "Sin información"].includes(estado)) return "alerta";
  return "";
}

// Agrupa una lista por un campo y devuelve { clave: { n, valor } }
function agrupar(lista, campo) {
  const grupos = {};
  lista.forEach(c => {
    const clave = c[campo] || "Sin dato";
    if (!grupos[clave]) grupos[clave] = { n: 0, valor: 0 };
    grupos[clave].n += 1;
    grupos[clave].valor += c.valor;
  });
  return grupos;
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// ===== 3. DESCARGA DE DATOS =====

// Si la API falla, intenta de nuevo hasta 3 veces
async function consultarConReintentos(url, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const respuesta = await fetch(url);
      if (!respuesta.ok) throw new Error("La API respondió con error " + respuesta.status);
      return await respuesta.json();
    } catch (error) {
      if (i === intentos) throw error;
      await esperar(1500 * i);
    }
  }
}

async function descargarAnio(anio) {
  const nits = NITS_EXTRA.map(n => `'${n}'`).join(",");
  const filtro =
    `fecha_de_firma >= '${anio}-01-01T00:00:00' AND fecha_de_firma < '${anio + 1}-01-01T00:00:00'` +
    ` AND (ciudad = 'Barrancabermeja' OR nit_entidad in (${nits}))`;

  let registros = [];
  let desde = 0;

  // La API entrega máximo POR_PAGINA registros por consulta, así que pedimos "páginas" hasta que no lleguen más
  while (true) {
    const parametros = new URLSearchParams({
      $select: CAMPOS.join(","),
      $where: filtro,
      $order: ":id",
      $limit: POR_PAGINA,
      $offset: desde
    });
    const lote = await consultarConReintentos(`${API}?${parametros}`);
    if (!Array.isArray(lote)) throw new Error("Respuesta inesperada de la API");

    registros = registros.concat(lote);
    $("estadoCarga").textContent = `Descargando contratos… ${numero(registros.length)}`;

    if (lote.length < POR_PAGINA) break;
    desde += POR_PAGINA;
  }

  // Quitar duplicados usando el identificador único del contrato
  const unicos = new Map();
  registros.forEach(c => {
    if (c.id_contrato && !unicos.has(c.id_contrato)) unicos.set(c.id_contrato, c);
  });
  app.duplicados = registros.length - unicos.size;

  // Preparar cada contrato con los datos ya calculados
  return [...unicos.values()].map(c => ({
    ...c,
    valor: Number(c.valor_del_contrato) || 0,
    estado: clasificarEstado(c.estado_contrato),
    tipo: clasificarTipo(c.tipodocproveedor),
    mes: (c.fecha_de_firma || "").slice(0, 7),
    entidad: c.nombre_entidad || "Sin dato",
    contratista: c.proveedor_adjudicado || "Sin dato",
    modalidad: c.modalidad_de_contratacion || "Sin dato",
    url: c.urlproceso?.url || ""
  }));
}

async function cargar() {
  const anio = Number($("anio").value);
  $("estadoCarga").textContent = "Conectando con SECOP II…";
  document.body.classList.add("cargando");

  try {
    app.todos = await descargarAnio(anio);
    app.consultadoEn = new Date();
    llenarListas();
    aplicarFiltros();

    $("estadoCarga").textContent =
      `${numero(app.todos.length)} contratos cargados · consultado ${app.consultadoEn.toLocaleString("es-CO")}`;
    $("actualizacion").textContent =
      `Consulta realizada el ${app.consultadoEn.toLocaleString("es-CO")} · ${numero(app.todos.length)} contratos únicos de ${anio}` +
      (app.duplicados ? ` · ${numero(app.duplicados)} registros duplicados descartados` : " · sin duplicados");
  } catch (error) {
    console.error(error);
    $("estadoCarga").textContent = "No se pudo conectar con SECOP II. Revisa tu internet y recarga la página.";
  } finally {
    document.body.classList.remove("cargando");
  }
}

// ===== 4. FILTROS =====

function llenarSelect(id, valores, textoTodos) {
  const select = $(id);
  const actual = select.value;
  select.innerHTML = "";
  select.add(new Option(textoTodos, ""));
  valores.forEach(v => select.add(new Option(v, v)));
  if (valores.includes(actual)) select.value = actual;
}

function llenarListas() {
  const unicos = campo => [...new Set(app.todos.map(c => c[campo]))].sort((a, b) => a.localeCompare(b, "es"));
  llenarSelect("filtroEntidad", unicos("entidad"), "Todas las entidades");
  llenarSelect("filtroModalidad", unicos("modalidad"), "Todas las modalidades");
  llenarSelect("filtroEstado", unicos("estado"), "Todos los estados");
}

function aplicarFiltros() {
  const texto = $("buscador").value.trim().toLowerCase();
  const entidad = $("filtroEntidad").value;
  const modalidad = $("filtroModalidad").value;
  const estado = $("filtroEstado").value;
  const tipo = $("filtroTipo").value;

  app.filtrados = app.todos.filter(c => {
    const coincideTexto = !texto ||
      c.contratista.toLowerCase().includes(texto) ||
      c.entidad.toLowerCase().includes(texto) ||
      (c.objeto_del_contrato || "").toLowerCase().includes(texto) ||
      (c.referencia_del_contrato || "").toLowerCase().includes(texto) ||
      (c.id_contrato || "").toLowerCase().includes(texto);
    return coincideTexto &&
      (!entidad || c.entidad === entidad) &&
      (!modalidad || c.modalidad === modalidad) &&
      (!estado || c.estado === estado) &&
      (!tipo || c.tipo === tipo);
  });

  app.filasVisibles = FILAS_TABLA;
  pintarTodo();
}

function limpiarFiltros() {
  $("buscador").value = "";
  ["filtroEntidad", "filtroModalidad", "filtroEstado", "filtroTipo"].forEach(id => $(id).value = "");
  aplicarFiltros();
}

function pintarTodo() {
  pintarIndicadores();
  pintarGraficos();
  pintarEntidades();
  pintarContratistas();
  pintarContratos();
}

// ===== 5. INDICADORES =====

function pintarIndicadores() {
  const lista = app.filtrados;
  const total = lista.reduce((s, c) => s + c.valor, 0);

  // Contratos
  $("kpiContratos").textContent = numero(lista.length);
  $("kpiContratosNota").textContent = lista.length === app.todos.length
    ? "todos los contratos del año"
    : `de ${numero(app.todos.length)} del año`;

  // Valor
  $("kpiValor").textContent = pesosCorto(total);
  $("kpiValorNota").textContent = pesos(total);

  // Contratación directa
  const directos = lista.filter(c => c.modalidad === "Contratación directa");
  const valorDirecto = directos.reduce((s, c) => s + c.valor, 0);
  $("kpiDirecta").textContent = porcentaje(directos.length, lista.length);
  $("kpiDirectaNota").textContent = `${numero(directos.length)} contratos · ${porcentaje(valorDirecto, total)} del valor`;

  // Contratistas distintos (empresas y personas)
  const contratistas = new Map();
  lista.forEach(c => contratistas.set(c.contratista, c.tipo));
  const tipos = [...contratistas.values()];
  $("kpiContratistas").textContent = numero(contratistas.size);
  $("kpiContratistasNota").textContent =
    `${numero(tipos.filter(t => t === "Empresa").length)} empresas · ${numero(tipos.filter(t => t === "Persona natural").length)} personas`;

  // En ejecución
  const enEjecucion = lista.filter(c => c.estado === "En ejecución");
  const terminados = lista.filter(c => ["Terminado", "Cerrado", "Liquidado"].includes(c.estado));
  $("kpiEjecucion").textContent = numero(enEjecucion.length);
  $("kpiEjecucionNota").textContent = `${numero(terminados.length)} terminados o cerrados`;

  // Concentración: qué porcentaje del dinero se llevan los 10 contratistas más grandes
  const top10 = Object.values(agrupar(lista, "contratista"))
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 10)
    .reduce((s, g) => s + g.valor, 0);
  $("kpiConcentracion").textContent = porcentaje(top10, total);
}

// ===== 6. GRÁFICOS =====

function color(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function dibujar(id, configuracion) {
  if (app.graficos[id]) app.graficos[id].destroy(); // borrar el gráfico anterior antes de redibujar
  app.graficos[id] = new Chart($(id), configuracion);
}

function recortar(texto, max = 40) {
  return texto.length > max ? texto.slice(0, max) + "…" : texto;
}

function pintarGraficos() {
  if (typeof Chart === "undefined") return;
  Chart.defaults.color = color("--texto-suave");
  Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.maintainAspectRatio = false;

  const paleta = [color("--verde-claro"), color("--dorado"), color("--azul"), color("--naranja"),
                  color("--rojo"), "#a78bfa", "#f472b6", "#94a3b8"];
  const lista = app.filtrados;
  const enMillones = { callbacks: { label: ctx => " " + pesosCorto(ctx.raw * 1e6) } };

  // Entidades (top 10 por valor)
  const entidades = Object.entries(agrupar(lista, "entidad")).sort((a, b) => b[1].valor - a[1].valor).slice(0, 10);
  dibujar("gEntidades", {
    type: "bar",
    data: {
      labels: entidades.map(e => recortar(e[0], 50)),
      datasets: [{ data: entidades.map(e => e[1].valor / 1e6), backgroundColor: color("--verde-claro"), borderRadius: 8 }]
    },
    options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: enMillones },
               scales: { x: { title: { display: true, text: "Millones de pesos" } } } }
  });

  // Mes a mes
  const meses = agrupar(lista, "mes");
  const ordenMeses = Object.keys(meses).filter(m => m !== "Sin dato").sort();
  dibujar("gMeses", {
    type: "line",
    data: {
      labels: ordenMeses,
      datasets: [{ data: ordenMeses.map(m => meses[m].valor / 1e6), borderColor: color("--dorado"),
                   backgroundColor: "rgba(245,185,21,0.15)", fill: true, tension: 0.35, pointRadius: 3 }]
    },
    options: { plugins: { legend: { display: false }, tooltip: enMillones } }
  });

  // Modalidad (cantidad de contratos)
  const modalidades = Object.entries(agrupar(lista, "modalidad")).sort((a, b) => b[1].n - a[1].n);
  dibujar("gModalidad", {
    type: "doughnut",
    data: { labels: modalidades.map(m => m[0]),
            datasets: [{ data: modalidades.map(m => m[1].n), backgroundColor: paleta, borderWidth: 0 }] },
    options: { cutout: "62%", plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } } }
  });

  // Empresas vs personas (valor)
  const tipos = Object.entries(agrupar(lista, "tipo"));
  dibujar("gTipo", {
    type: "doughnut",
    data: { labels: tipos.map(t => t[0]),
            datasets: [{ data: tipos.map(t => t[1].valor / 1e6), backgroundColor: [color("--azul"), color("--dorado"), "#94a3b8"], borderWidth: 0 }] },
    options: { cutout: "62%", plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } }, tooltip: enMillones } }
  });

  // Estados (cantidad)
  const estados = Object.entries(agrupar(lista, "estado")).sort((a, b) => b[1].n - a[1].n);
  dibujar("gEstados", {
    type: "bar",
    data: { labels: estados.map(e => e[0]),
            datasets: [{ data: estados.map(e => e[1].n), backgroundColor: paleta, borderRadius: 8 }] },
    options: { plugins: { legend: { display: false } } }
  });
}

// ===== 7. TABLAS =====

function pintarEntidades() {
  const filas = Object.entries(agrupar(app.filtrados, "entidad")).sort((a, b) => b[1].valor - a[1].valor);

  $("tablaEntidades").innerHTML = filas.map(([nombre, g]) => {
    const deLaEntidad = app.filtrados.filter(c => c.entidad === nombre);
    const ejecucion = deLaEntidad.filter(c => c.estado === "En ejecución").length;
    const directos = deLaEntidad.filter(c => c.modalidad === "Contratación directa").length;
    return `
      <tr class="clic" data-entidad="${escapar(nombre)}">
        <td>${escapar(nombre)}</td>
        <td class="num">${numero(g.n)}</td>
        <td class="valor">${pesosCorto(g.valor)}</td>
        <td class="num">${numero(ejecucion)}</td>
        <td class="num">${porcentaje(directos, g.n)}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="5">No hay contratos con estos filtros.</td></tr>`;
}

function pintarContratistas() {
  const total = app.filtrados.reduce((s, c) => s + c.valor, 0);
  const datos = {};
  app.filtrados.forEach(c => {
    if (!datos[c.contratista]) datos[c.contratista] = { n: 0, valor: 0, tipo: c.tipo, entidades: new Set() };
    const d = datos[c.contratista];
    d.n += 1;
    d.valor += c.valor;
    d.entidades.add(c.entidad);
  });

  const filas = Object.entries(datos).sort((a, b) => b[1].valor - a[1].valor).slice(0, 25);
  const mayor = filas.length ? filas[0][1].valor : 1;

  $("tablaContratistas").innerHTML = filas.map(([nombre, d], i) => `
    <tr class="clic" data-contratista="${escapar(nombre)}">
      <td>${i + 1}</td>
      <td>${escapar(nombre)}</td>
      <td><span class="etiqueta">${d.tipo}</span></td>
      <td class="num">${numero(d.n)}</td>
      <td class="num">${numero(d.entidades.size)}</td>
      <td class="valor">${pesosCorto(d.valor)}</td>
      <td class="num">${porcentaje(d.valor, total)}<div class="barra"><i style="width:${(d.valor / mayor * 100).toFixed(1)}%"></i></div></td>
    </tr>`).join("") || `<tr><td colspan="7">No hay contratos con estos filtros.</td></tr>`;
}

function pintarContratos() {
  const lista = [...app.filtrados].sort((a, b) => (b.fecha_de_firma || "").localeCompare(a.fecha_de_firma || ""));
  const total = lista.reduce((s, c) => s + c.valor, 0);
  const visibles = lista.slice(0, app.filasVisibles);

  $("contador").textContent =
    `${numero(lista.length)} contratos · ${pesos(total)} · mostrando ${numero(visibles.length)}`;

  $("tablaContratos").innerHTML = visibles.map(c => `
    <tr class="clic" data-id="${escapar(c.id_contrato)}">
      <td>${fecha(c.fecha_de_firma)}</td>
      <td>${escapar(c.referencia_del_contrato || c.id_contrato)}</td>
      <td>${escapar(recortar(c.entidad, 45))}</td>
      <td>${escapar(c.contratista)}</td>
      <td class="objeto">${escapar(recortar(c.objeto_del_contrato || "", 110))}</td>
      <td><span class="etiqueta ${claseEstado(c.estado)}">${escapar(c.estado)}</span></td>
      <td class="valor">${pesos(c.valor)}</td>
    </tr>`).join("") || `<tr><td colspan="7">No hay contratos con estos filtros.</td></tr>`;

  $("btnMas").style.display = lista.length > app.filasVisibles ? "block" : "none";
}

// ===== 8. FICHA DEL CONTRATO =====

function abrirFicha(id) {
  const c = app.todos.find(x => x.id_contrato === id);
  if (!c) return;

  const dato = (titulo, valor, completo = false) =>
    `<div class="${completo ? "completo" : ""}"><span>${titulo}</span>${escapar(valor || "Sin dato")}</div>`;

  $("fichaContenido").innerHTML = `
    <span class="etiqueta ${claseEstado(c.estado)}">${escapar(c.estado)}</span>
    <h3 class="ficha-titulo">${escapar(c.referencia_del_contrato || c.id_contrato)}</h3>
    <div class="ficha-grid">
      ${dato("Objeto del contrato", c.objeto_del_contrato, true)}
      ${dato("Entidad contratante", c.entidad)}
      ${dato("Contratista", c.contratista)}
      ${dato("Tipo de contratista", c.tipo)}
      ${dato("Tipo de contrato", c.tipo_de_contrato)}
      ${dato("Modalidad", c.modalidad)}
      ${dato("Valor del contrato", pesos(c.valor))}
      ${dato("Fecha de firma", fecha(c.fecha_de_firma))}
      ${dato("Fecha de inicio", fecha(c.fecha_de_inicio_del_contrato))}
      ${dato("Fecha de terminación", fecha(c.fecha_de_fin_del_contrato))}
      ${dato("Días adicionados", c.dias_adicionados)}
      ${dato("Estado reportado en SECOP", c.estado_contrato)}
      ${dato("Identificador SECOP", c.id_contrato)}
    </div>
    ${c.url ? `<a class="ficha-enlace" href="${escapar(c.url)}" target="_blank" rel="noopener">Ver registro oficial en SECOP ↗</a>` : ""}
  `;
  $("ficha").showModal();
}

// ===== 9. EXPORTAR E IMPRIMIR =====

function descargarExcel() {
  if (typeof XLSX === "undefined") {
    alert("No se pudo cargar la herramienta de Excel. Revisa tu conexión.");
    return;
  }
  const filas = app.filtrados.map(c => ({
    "Identificador SECOP": c.id_contrato,
    "Número de contrato": c.referencia_del_contrato,
    "Fecha de firma": fecha(c.fecha_de_firma),
    "Fecha de inicio": fecha(c.fecha_de_inicio_del_contrato),
    "Fecha de terminación": fecha(c.fecha_de_fin_del_contrato),
    "Entidad": c.entidad,
    "Contratista": c.contratista,
    "Tipo de contratista": c.tipo,
    "Objeto": c.objeto_del_contrato,
    "Tipo de contrato": c.tipo_de_contrato,
    "Modalidad": c.modalidad,
    "Estado": c.estado,
    "Valor": c.valor,
    "Enlace SECOP": c.url
  }));

  const hoja = XLSX.utils.json_to_sheet(filas);
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Contratos");

  const nota = XLSX.utils.aoa_to_sheet([
    ["Fuente", "SECOP II - datos.gov.co (conjunto jbjy-vk9h)"],
    ["Consulta", app.consultadoEn ? app.consultadoEn.toLocaleString("es-CO") : ""],
    ["Año", $("anio").value],
    ["Contratos en el archivo", filas.length],
    ["Aviso", "Iniciativa ciudadana. Cifras indicativas según lo reportado por las entidades en SECOP II."]
  ]);
  XLSX.utils.book_append_sheet(libro, nota, "Fuente");

  XLSX.writeFile(libro, `contratos-barrancabermeja-${$("anio").value}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ===== 10. ARRANQUE =====

function iniciar() {
  // Años disponibles: del actual hacia atrás
  const actual = new Date().getFullYear();
  for (let a = actual; a >= 2021; a--) $("anio").add(new Option(a, a));

  // Eventos de filtros
  let pausa;
  $("buscador").addEventListener("input", () => { clearTimeout(pausa); pausa = setTimeout(aplicarFiltros, 250); });
  ["filtroEntidad", "filtroModalidad", "filtroEstado", "filtroTipo"].forEach(id => $(id).addEventListener("change", aplicarFiltros));
  $("btnLimpiar").addEventListener("click", limpiarFiltros);
  $("anio").addEventListener("change", cargar);

  // Botones
  $("btnExcel").addEventListener("click", descargarExcel);
  $("btnImprimir").addEventListener("click", () => window.print());
  $("btnMas").addEventListener("click", () => { app.filasVisibles += FILAS_TABLA; pintarContratos(); });
  $("btnCerrarFicha").addEventListener("click", () => $("ficha").close());

  // Clics en las tablas
  $("tablaEntidades").addEventListener("click", e => {
    const fila = e.target.closest("tr[data-entidad]");
    if (!fila) return;
    $("filtroEntidad").value = fila.dataset.entidad;
    aplicarFiltros();
    $("contratos").scrollIntoView();
  });
  $("tablaContratistas").addEventListener("click", e => {
    const fila = e.target.closest("tr[data-contratista]");
    if (!fila) return;
    $("buscador").value = fila.dataset.contratista;
    aplicarFiltros();
    $("contratos").scrollIntoView();
  });
  $("tablaContratos").addEventListener("click", e => {
    const fila = e.target.closest("tr[data-id]");
    if (fila) abrirFicha(fila.dataset.id);
  });

  cargar();
}

iniciar();
