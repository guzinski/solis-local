import type { IncomingMessage, ServerResponse } from "node:http";

const words = {
  "en-US": {
    unavailable: "Your dashboard is temporarily unavailable",
    unavailableBody: "The connection reached Solar, but the dashboard is not responding. It may still be starting. Wait a moment and try again.",
    forbidden: "This page is not available here",
    forbiddenBody: "Open the linking page on your home computer. For remote dashboard access, use the linked Solar app.",
    missing: "We couldn’t find this page",
    missingBody: "The address may be incomplete or the app download may not be ready yet.",
    generic: "We couldn’t complete your request",
    genericBody: "Please wait a moment and try again.",
    retry: "Try again", details: "Technical details", footer: "Your data stays on your own system.",
  },
  "pt-BR": {
    unavailable: "Seu painel está temporariamente indisponível",
    unavailableBody: "A conexão chegou ao Solar, mas o painel não está respondendo. Ele pode estar iniciando. Aguarde um momento e tente novamente.",
    forbidden: "Esta página não está disponível aqui",
    forbiddenBody: "Abra a página de vínculo no computador de casa. Para acessar o painel remotamente, use o app Solar já vinculado.",
    missing: "Não encontramos esta página",
    missingBody: "O endereço pode estar incompleto ou o download do app ainda não está pronto.",
    generic: "Não foi possível concluir a solicitação",
    genericBody: "Aguarde um momento e tente novamente.",
    retry: "Tentar novamente", details: "Detalhes técnicos", footer: "Seus dados ficam no seu próprio sistema.",
  },
};
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]!);

export function errorLanguage(accept = ""): "pt-BR" | "en-US" {
  const choices = accept.split(",").map((part) => {
    const [language,...parameters] = part.trim().split(";");
    const q = parameters.find((p) => p.trim().startsWith("q="));
    return { language, q: q ? Number(q.trim().slice(2)) : 1 };
  }).filter((p) => p.q > 0).sort((a,b) => b.q-a.q);
  for (const {language} of choices) {
    if (/^pt(?:-|$)/i.test(language)) return "pt-BR";
    if (/^en(?:-|$)/i.test(language)) return "en-US";
  }
  return "en-US";
}

export function renderErrorPage(status: number, language: "pt-BR" | "en-US", error: string): string {
  const w = words[language];
  const kind = status === 502 || status === 503 ? "unavailable" : status === 403 ? "forbidden" : status === 404 ? "missing" : "generic";
  const title = w[kind], body = w[`${kind}Body`];
  const details = escape(JSON.stringify({ status, error }, null, 2));
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Solar · ${escape(title)}</title>
<style>:root{color-scheme:light;--page:#f9f9f7;--card:#fcfcfb;--ink:#25251f;--muted:#68675e;--line:#e1e0d9;--sun:#d38a00}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--card:#1a1a19;--ink:#f0efec;--muted:#c3c2b7;--line:#383835;--sun:#f5b324}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.6 system-ui;background:var(--page);color:var(--ink)}main{width:100%;max-width:480px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:32px}.brand{font-weight:650;color:var(--sun);margin:0 0 28px}.code{font-size:12px;color:var(--muted)}h1{font-size:27px;line-height:1.25;margin:8px 0 16px}p{color:var(--muted)}a{display:inline-block;border-radius:10px;background:var(--sun);color:#17140a;text-decoration:none;font-weight:650;padding:10px 18px;margin:12px 0}a:focus-visible{outline:2px solid var(--ink);outline-offset:3px}details{border-top:1px solid var(--line);margin-top:24px;padding-top:16px;font-size:13px;color:var(--muted)}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}footer{font-size:12px;margin-top:24px;color:var(--muted)}</style></head>
<body><main><p class="brand">☀ Solar Monitor</p><span class="code">HTTP ${status}</span><h1>${escape(title)}</h1><p>${escape(body)}</p><a href="">${w.retry}</a><details><summary>${w.details}</summary><pre>${details}</pre></details><footer>${w.footer}</footer></main></body></html>`;
}

export function sendGatewayError(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  // API consumers keep their stable machine-readable contract; navigations get
  // an actual page, with the same information available in collapsed details.
  const path = req.url?.split("?")[0] ?? "/";
  if (path.startsWith("/api/") || path === "/mobile/health") {
    res.writeHead(status, { "content-type":"application/json", "cache-control":"no-store" });
    res.end(JSON.stringify({error})); return;
  }
  const language = errorLanguage(req.headers["accept-language"]);
  res.writeHead(status, {
    "content-type":"text/html; charset=utf-8", "cache-control":"no-store", "x-content-type-options":"nosniff",
    "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(req.method === "HEAD" ? undefined : renderErrorPage(status,language,error));
}
