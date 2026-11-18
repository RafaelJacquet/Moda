// Client TCP vers le pont Blender MCP (conteneur Docker, port 9876).
// Protocole : un JSON {type, params} par connexion -> {status, result|message}.
import net from 'node:net';
import { config } from './config.js';

function sendCommand(type, params = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.blender.host,
      port: config.blender.port,
    });
    let buffer = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      fn(value);
    };

    socket.setTimeout(timeoutMs, () =>
      finish(reject, new Error(`Blender : délai dépassé (${type})`))
    );
    socket.on('error', (err) =>
      finish(reject, new Error(`Blender injoignable (${config.blender.host}:${config.blender.port}) : ${err.message}`))
    );
    socket.on('connect', () => socket.write(JSON.stringify({ type, params })));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      try {
        const response = JSON.parse(buffer);
        if (response.status === 'success') finish(resolve, response.result);
        else finish(reject, new Error(`Blender : ${response.message || 'erreur inconnue'}`));
      } catch {
        /* JSON incomplet : on attend la suite */
      }
    });
    socket.on('close', () => {
      if (!done) finish(reject, new Error('Blender : connexion fermée sans réponse'));
    });
  });
}

export const blender = {
  async ping() {
    return sendCommand('ping', {}, 5000);
  },
  async isUp() {
    try {
      await this.ping();
      return true;
    } catch {
      return false;
    }
  },
  resetScene() {
    return sendCommand('reset_scene', {}, 60000);
  },
  executeCode(code) {
    return sendCommand('execute_code', { code }, 300000);
  },
  sceneSummary() {
    return sendCommand('scene_summary', {}, 60000);
  },
  renderViews(outDir, { resolution = 512, samples = 24 } = {}) {
    return sendCommand('render_views', { out_dir: outDir, resolution, samples }, 600000);
  },
  exportGlb(outPath) {
    return sendCommand('export_glb', { out_path: outPath }, 300000);
  },
};
