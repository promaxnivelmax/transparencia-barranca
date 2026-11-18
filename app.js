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

cargarContratos();