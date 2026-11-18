const URL_API = "https://www.datos.gov.co/resource/jbjy-vk9h.json";

async function cargarContratos() {
  const parametros = new URLSearchParams({
    ciudad: "Barrancabermeja",
    $where: "fecha_de_firma >= '2026-01-01T00:00:00'",
    $order: "fecha_de_firma DESC",
    $limit: 5000
  });

  const respuesta = await fetch(`${URL_API}?${parametros}`);
  const contratos = await respuesta.json();

  console.log(contratos);

  const total = contratos.reduce((suma, c) => suma + Number(c.valor_del_contrato), 0);

  document.getElementById("numContratos").textContent = contratos.length;
  document.getElementById("totalContratado").textContent =
    total.toLocaleString("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
}

cargarContratos();