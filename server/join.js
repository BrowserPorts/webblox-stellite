const { ISOLATION_HEADERS, SKIP_RESPONSE_HEADERS } = require('./shared');
const { storeCookies } = require('./session');
const { clientId } = require('./delivered');
const { noteJoin } = require('./place-cache');

function spoofNativeUa(headers) {
  const copy = { ...headers };
  const rbxUa = copy['rbx-user-agent'];
  if (rbxUa) {
    copy['rbx-user-agent'] = rbxUa
      .replace(/Roblox\/Web\s+\w+\s+Desktop/, 'Roblox/WinInet')
      .replace(/\s*Browser\/\S+/, '');
  }
  return copy;
}

function qdmuxFqdn(joinScript) {
  const udmux = joinScript.UdmuxEndpoints && joinScript.UdmuxEndpoints[0];
  const nst = String(joinScript.NetStackTokenValue || '');
  if (!udmux || !nst || !joinScript.MachineAddress || !joinScript.NetStackPort) return null;
  const token = /^[0-9a-f]{32}$/i.test(nst) ? nst.toLowerCase() : Buffer.from(nst, 'base64').toString('hex');
  if (token.length !== 32) return null;
  const octets = udmux.Address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !(n >= 0 && n <= 255))) return null;
  octets[3] += 1;
  const hex = list => list.map(n => n.toString(16).padStart(2, '0')).join('');
  const machine = joinScript.MachineAddress.split('.').map(Number);
  return `${token}-${hex(machine)}-${Number(joinScript.NetStackPort).toString(16)}.${hex(octets)}.qdmux.roblox.com`;
}

function summarizeJoin(text) {
  try {
    const j = JSON.parse(text);
    const js = j.joinScript || null;
    return JSON.stringify({
      status: j.status,
      message: j.message,
      jobId: j.jobId,
      hasJoinScript: !!js,
      keys: js ? Object.keys(js).filter(k => !/ticket|token|signature|appearance/i.test(k)) : undefined,
      udmux: js && js.UdmuxEndpoints && js.UdmuxEndpoints[0],
      serverPort: js && js.ServerPort,
      machineAddress: js && js.MachineAddress,
      hasNetStack: !!(js && js.NetStackConfig),
      platformTypeId: js && js.PlatformTypeId,
      directServerReturn: js && js.DirectServerReturn,
      superSafeChat: js && js.SuperSafeChat,
      pingUrl: js && js.PingUrl,
      pingInterval: js && js.PingInterval,
      clientPort: js && js.ClientPort,
    }).slice(0, 1600);
  } catch {
    return '[non-JSON response]';
  }
}

async function doFetch(url, method, headers, body) {
  const resp = await fetch(url, { method, headers, body, redirect: 'follow' });
  const data = Buffer.from(await resp.arrayBuffer());
  return { resp, data };
}

const LAUNCHER_JOIN = /(?:^|;\s*)launcher_join=(\d+):([gp]):([A-Za-z0-9-]+)/;

function launcherJoin(req, targetUrl, body) {
  const match = /\/v1\/join-game$/.test(targetUrl) && LAUNCHER_JOIN.exec(req.headers.cookie || '');
  if (!match) return { targetUrl, body };
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (String(parsed.placeId) !== match[1] || parsed.isTeleport) return { targetUrl, body };
    const server = match[2] === 'g' ? { gameId: match[3] } : { accessCode: match[3] };
    return {
      targetUrl: targetUrl.replace(/\/join-game$/, match[2] === 'g' ? '/join-game-instance' : '/join-private-game'),
      body: Buffer.from(JSON.stringify({ ...parsed, ...server })),
    };
  } catch {
    return { targetUrl, body };
  }
}

let lastJoinAt = null;

function lastGameJoin() {
  return lastJoinAt;
}

async function handleGameJoin(req, res, targetUrl, headers, body) {
  lastJoinAt = new Date().toISOString();
  console.log('[gamejoin]', req.method, targetUrl);
  if (body) try { console.log('[gamejoin] body:', body.toString('utf8').slice(0, 500)); } catch {}
  console.log('[gamejoin] rbx-user-agent:', headers['rbx-user-agent'] || '(none)');
  console.log('[gamejoin] user-agent:', (headers['user-agent'] || '(none)').slice(0, 200));

  let { resp, data } = await doFetch(targetUrl, req.method, spoofNativeUa(headers), body);
  storeCookies(res, resp.headers.getSetCookie());

  let text = data.toString('utf8');
  console.log('[gamejoin] native-ua response', resp.status, summarizeJoin(text));

  if (resp.status === 200) {
    try {
      const json = JSON.parse(text);
      if (json.joinScript) {
        noteJoin(clientId(req), json.joinScript);
        const fqdn = !json.joinScript.gameFqdn && qdmuxFqdn(json.joinScript);
        if (fqdn) {
          json.joinScript.gameFqdn = fqdn;
          console.log(`[gamejoin] built qdmux fqdn for ${json.joinScript.MachineAddress}:${json.joinScript.NetStackPort}`);
          data = Buffer.from(JSON.stringify(json));
          text = data.toString('utf8');
        }
      }
    } catch (e) {
      console.error('[gamejoin] parse error:', e.message);
    }
  }

  const resHeaders = {};
  for (const [k, v] of resp.headers) {
    if (!SKIP_RESPONSE_HEADERS.has(k)) resHeaders[k] = v;
  }
  Object.assign(resHeaders, ISOLATION_HEADERS);
  resHeaders['Content-Length'] = data.length;
  res.writeHead(resp.status, resHeaders);
  res.end(data);
}

module.exports = {
  handleGameJoin,
  launcherJoin,
  lastGameJoin,
};
