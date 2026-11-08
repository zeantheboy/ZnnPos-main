const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const DEFAULT_PORT = 4173;
const MAX_PORT_SCAN = 20;

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.once('close', () => resolve(true));
      tester.close();
    });

    tester.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort = DEFAULT_PORT, range = MAX_PORT_SCAN) {
  for (let offset = 0; offset < range; offset += 1) {
    const port = startPort + offset;
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error(`No free port found between ${startPort} and ${startPort + range}`);
}

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    function ping() {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(ping, 250);
      });
    }

    ping();
  });
}

async function main() {
  const port = await findAvailablePort();
  const frontendDir = path.join(__dirname, 'frontend');
  const frontendEnv = {
    ...process.env,
    PORT: String(port),
    APP_PORT: String(port)
  };

  const frontend = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(port), '--strictPort', 'false'],
    {
      cwd: frontendDir,
      env: frontendEnv,
      stdio: 'inherit'
    }
  );

  frontend.on('exit', (code) => {
    if (code !== 0) {
      console.error(`Frontend exited with code ${code}`);
      process.exit(code || 1);
    }
  });

  try {
    await waitForHttp(`http://localhost:${port}`);
  } catch (error) {
    console.error(error.message);
    frontend.kill('SIGTERM');
    process.exit(1);
  }

  const electron = spawn(
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
    ['.'],
    {
      cwd: __dirname,
      env: {
        ...process.env,
        APP_PORT: String(port)
      },
      stdio: 'inherit'
    }
  );

  electron.on('exit', (code) => {
    frontend.kill('SIGTERM');
    process.exit(code || 0);
  });
}

main().catch((error) => {
    console.error('Failed to start ZnnCashier:', error);
  process.exit(1);
});
