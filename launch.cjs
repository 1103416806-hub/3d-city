const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const url = 'http://127.0.0.1:5178/';
const entry = path.join(__dirname, 'dist', 'index.html');

function reachable() {
  return new Promise(resolve => {
    const request = http.get(url, response => { response.resume(); resolve(response.statusCode === 200); });
    request.setTimeout(800, () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function main() {
  if (!fs.existsSync(entry)) throw new Error('缺少网页文件，请先运行 npm run build。');
  if (!await reachable()) {
    const server = spawn(process.execPath, ['--preserve-symlinks-main', path.join(__dirname, 'server.cjs')], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname,
    });
    server.unref();
    for (let i = 0; i < 30 && !await reachable(); i++) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!await reachable()) throw new Error('本机服务没有成功启动。请确认 Node.js 可用，并允许端口 5178。');
  spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' }).unref();
}

main().catch(error => {
  console.error(error.message);
  spawn('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${String(error.message).replaceAll("'", "''")}', '3D城市启动失败')`], { windowsHide: false });
  process.exitCode = 1;
});
