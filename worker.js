// Worker del Tablero KyL — guarda y lee los datos en Cloudflare KV
// para que cualquier dispositivo que abra el tablero vea siempre la última versión.

// Conexión de SOLO LECTURA al tablero de comisiones (Supabase), para la
// pestaña "Rentabilidad" — nunca escribe nada ahí, solo consulta.
const SUPABASE_URL = "https://dduynhzwaqmmcxhfcbnv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdXluaHp3YXFtbWN4aGZjYm52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4Mjg1NzAsImV4cCI6MjA5ODQwNDU3MH0.uqUGeawz73pzT8tz4IutdBtUem6b7WiFcK2gIcJDzac";

// Saca el N° de pedido real (ej. "S04442") desde el campo de texto libre
// "observacion" del tablero de comisiones, donde el conductor lo anota a mano
// (ej. "Pedido s04442"). El campo "guia" NO sirve para este cruce: es la guía
// de despacho, un documento distinto que no coincide con la Referencia de
// pedido que usa el Tablero de Viajes.
function extraerReferencia(observacion) {
  const texto = String(observacion || "");
  const m = texto.match(/s\s*0?(\d{4,5})/i);
  if (!m) return null;
  const digitos = m[1].length === 4 ? "0" + m[1] : m[1];
  return "S" + digitos;
}

// Normaliza el campo "pedido" de un fondo (ej. "s04455") al mismo formato
// que usa el Tablero de Viajes (ej. "S04455").
function normalizarPedido(pedido) {
  const texto = String(pedido || "").trim();
  if (!texto) return null;
  return texto.toUpperCase();
}

// Suma viáticos + peajes + reembolsos + cualquier otro gasto reportado
// (tablero de comisiones guarda todo como líneas de "rendiciones"/"extras"
// sueltas, sin categorías separadas — así que se suman todas como
// "otros gastos" del viaje) y las agrupa por N° de pedido.
function calcularGastosPorPedido(data) {
  const fondos = Array.isArray(data.fondos) ? data.fondos : [];
  const rendiciones = Array.isArray(data.rendiciones) ? data.rendiciones : [];
  const extras = Array.isArray(data.extras) ? data.extras : [];

  const montoPorFondoId = {};
  const acumular = (lista) => {
    lista.forEach((r) => {
      if (!r || !r.fondoId) return;
      const monto = Number(r.monto) || 0;
      montoPorFondoId[r.fondoId] = (montoPorFondoId[r.fondoId] || 0) + monto;
    });
  };
  acumular(rendiciones);
  acumular(extras);

  const gastosPorPedido = {};
  fondos.forEach((f) => {
    const ref = normalizarPedido(f && f.pedido);
    if (!ref) return;
    const gastos = montoPorFondoId[f.id] || 0;
    gastosPorPedido[ref] = (gastosPorPedido[ref] || 0) + gastos;
  });
  return gastosPorPedido;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- API de datos (lo que agregamos nuevo) ---
    if (url.pathname === "/api/datos") {
      // Preflight CORS (por si acaso)
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }

      // Leer los datos guardados
      if (request.method === "GET") {
        const data = await env.KYL_DATA.get("datos_kyl");
        return new Response(data ?? "null", {
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      // Guardar datos nuevos (el tablero llama esto automáticamente
      // cada vez que importas algo o cambias un dato)
      if (request.method === "POST") {
        const body = await request.text();
        // límite de seguridad: no guardar cosas absurdamente grandes por error
        if (body.length > 20_000_000) {
          return new Response('{"ok":false,"error":"payload demasiado grande"}', {
            status: 413,
            headers: { "Content-Type": "application/json", ...corsHeaders() },
          });
        }
        await env.KYL_DATA.put("datos_kyl", body);
        return new Response('{"ok":true}', {
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // --- API de rentabilidad: trae SOLO los viajes con litros ya cargados
    // desde el tablero de comisiones (Supabase), más los gastos asociados
    // (viáticos, peajes, reembolsos) agrupados por N° de pedido.
    // Nunca escribe nada allá.
    if (url.pathname === "/api/rentabilidad") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }
      if (request.method === "GET") {
        try {
          const supaRes = await fetch(
            `${SUPABASE_URL}/rest/v1/kyl_datos?id=eq.empresa&select=data`,
            {
              headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              },
            }
          );
          if (!supaRes.ok) {
            return new Response("[]", {
              headers: { "Content-Type": "application/json", ...corsHeaders() },
            });
          }
          const rows = await supaRes.json();
          const raw = rows && rows[0] && rows[0].data;
          const data = typeof raw === "string" ? JSON.parse(raw) : raw;
          const trips = (data && data.trips) || [];
          const gastosPorPedido = calcularGastosPorPedido(data || {});

          // Solo los viajes que ya tienen litros cargados (dato real de costo)
          const conCosto = trips
            .filter((t) => t.litros !== "" && t.litros != null && !isNaN(Number(t.litros)) && Number(t.litros) > 0)
            .map((t) => {
              const ref = extraerReferencia(t.observacion);
              return {
                guia: t.guia || "",
                ref,
                fecha: t.fecha || "",
                litros: Number(t.litros) || 0,
                rendido: !!t.rendido,
                liquidado: t.liquidado || null,
                gastosOtros: ref && gastosPorPedido[ref] != null ? gastosPorPedido[ref] : 0,
              };
            });
          return new Response(JSON.stringify(conCosto), {
            headers: { "Content-Type": "application/json", ...corsHeaders() },
          });
        } catch (e) {
          return new Response("[]", {
            headers: { "Content-Type": "application/json", ...corsHeaders() },
          });
        }
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // --- Todo lo demás: servir el tablero (index.html) normal ---
    return env.ASSETS.fetch(request);
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
