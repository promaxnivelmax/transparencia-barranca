const URL_API = "https://www.datos.gov.co/resource/jbjy-vk9h.json";

function aPesos(valor) {
  return valor.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
}

async function cargarContratos() {
  const parametros = new URLSearchParams({
    ciudad: "Barrancabermeja",
    $where: "fecha_de_firma >= '2026-01-01T00:00:00'",
    $order: "fecha_de_firma DESC",
    $limit: 5000
  });

  const respuesta = await fetch(`${URL_API}?${parametros}`);
  const contratos = await respuesta.json();

  // 1. Número de contratos
  document.getElementById("numContratos").textContent = contratos.length.toLocaleString("es-CO");

  // 2. Total contratado
  const total = contratos.reduce((suma, c) => suma + Number(c.valor_del_contrato), 0);
  document.getElementById("totalContratado").textContent = aPesos(total);

  // 3. Porcentaje de contratación directa
  const directos = contratos.filter(c => c.modalidad_de_contratacion === "Contratación directa").length;
  const porcentaje = (directos / contratos.length) * 100;
  document.getElementById("porcentajeDirecta").textContent = porcentaje.toFixed(1) + " %";

  // 4. Contratista con más plata
  const porContratista = {};
  contratos.forEach(c => {
    const nombre = c.proveedor_adjudicado;
    porContratista[nombre] = (porContratista[nombre] || 0) + Number(c.valor_del_contrato);
  });
  const [nombreTop, valorTop] = Object.entries(porContratista).sort((a, b) => b[1] - a[1])[0];
  document.getElementById("topContratista").textContent = `${nombreTop} (${aPesos(valorTop)})`;
}
  dibujarGraficos(contratos);
  function agruparYSumar(contratos, campo) {
  const grupos = {};
  contratos.forEach(c => {
    const clave = c[campo] || "Sin dato";
    grupos[clave] = (grupos[clave] || 0) + Number(c.valor_del_contrato);
  });
  return grupos;
}

function dibujarGraficos(contratos) {
  Chart.defaults.color = "#cbd5e1";
  Chart.defaults.borderColor = "#1f2a44";
  const colores = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#60a5fa", "#4ade80"];

  // Gráfico 1: Top 10 entidades
  const entidades = Object.entries(agruparYSumar(contratos, "nombre_entidad"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  new Chart(document.getElementById("graficoEntidades"), {
    type: "bar",
    data: {
      labels: entidades.map(e => e[0].length > 45 ? e[0].slice(0, 45) + "…" : e[0]),
      datasets: [{ data: entidades.map(e => e[1] / 1000000), backgroundColor: "#38bdf8", borderRadius: 6 }]
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } } }
  });

  // Gráfico 2: Modalidades (cantidad de contratos)
  const modalidades = {};
  contratos.forEach(c => {
    const m = c.modalidad_de_contratacion || "Sin dato";
    modalidades[m] = (modalidades[m] || 0) + 1;
  });

  new Chart(document.getElementById("graficoModalidad"), {
    type: "doughnut",
    data: {
      labels: Object.keys(modalidades),
      datasets: [{ data: Object.values(modalidades), backgroundColor: colores, borderWidth: 0 }]
    },
    options: { plugins: { legend: { position: "bottom" } } }
  });

  // Gráfico 3: Mes a mes
  const meses = {};
  contratos.forEach(c => {
    const mes = c.fecha_de_firma.slice(0, 7);
    meses[mes] = (meses[mes] || 0) + Number(c.valor_del_contrato);
  });
  const mesesOrdenados = Object.keys(meses).sort();

  new Chart(document.getElementById("graficoMeses"), {
    type: "line",
    data: {
      labels: mesesOrdenados,
      datasets: [{
        data: mesesOrdenados.map(m => meses[m] / 1000000),
        borderColor: "#34d399",
        backgroundColor: "rgba(52, 211, 153, 0.15)",
        fill: true,
        tension: 0.3
      }]
    },
    options: { plugins: { legend: { display: false } } }
  });
}
cargarContratos();