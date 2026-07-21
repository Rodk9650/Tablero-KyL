// Worker del Tablero KyL — guarda y lee los datos en Cloudflare KV
// para que cualquier dispositivo que abra el tablero vea siempre la última versión.

// Conexión de SOLO LECTURA al tablero de comisiones (Supabase), para la
// pestaña "Rentabilidad" — nunca escribe nada ahí, solo consulta.
const SUPABASE_URL = "https://dduynhzwaqmmcxhfcbnv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdXluaHp3YXFtbWN4aGZjYm52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4Mjg1NzAsImV4cCI6MjA5ODQwNDU3MH0.uqUGeawz73pzT8tz4IutdBtUem6b7WiFcK2gIcJDzac";

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
    // desde el tablero de comisiones (Supabase). Nunca escribe nada allá.
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
          // Solo los viajes que ya tienen litros cargados (dato real de costo)
          const conCosto = trips
            .filter((t) => t.litros !== "" && t.litros != null && !isNaN(Number(t.litros)) && Number(t.litros) > 0)
            .map((t) => ({
              guia: t.guia || "",
              fecha: t.fecha || "",
              litros: Number(t.litros) || 0,
              rendido: !!t.rendido,
              liquidado: t.liquidado || null,
            }));
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
    // Si tu Worker ya tenía código propio para servir el archivo,
    // reemplaza la línea de abajo por lo que ya tenías ahí.
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

