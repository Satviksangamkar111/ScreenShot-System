import { createServer } from 'http';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { launchChrome } from './chrome-launcher.js';
import { CDPClient } from './cdp-client.js';
import { CDPSession } from './cdp-session.js';
import { PageShim } from './page-shim.js';
import { saveStorageState, loadStorageState, applyOriginLocalStorage } from './storage-state.js';

const FIXTURE_HTML = readFileSync(join(process.cwd(), 'src/automation/test-phase-c-fixture.html'), 'utf-8');
const TEST_STATE_PATH = join(process.cwd(), 'src/automation/test-phase-c-state.json');

async function attachSession(debuggerUrl: string) {
  const cdpClient = new CDPClient(debuggerUrl);
  await cdpClient.connect();

  const targetsResp = (await cdpClient.send('Target.getTargets', {})) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  const pageTarget = targetsResp.targetInfos.find((t) => t.type === 'page');
  if (!pageTarget) throw new Error('No page target found');

  const attachResp = (await cdpClient.send('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  })) as { sessionId: string };

  const cdpSession = new CDPSession(cdpClient, attachResp.sessionId, pageTarget.targetId);
  const page = new PageShim(cdpSession);
  await page.enable();

  return { cdpClient, cdpSession, page };
}

async function testPhaseC() {
  console.log('🚀 Phase C Test: Session Lifecycle (storage-state)');
  console.log('====================================================\n');

  const server = createServer((req, res) => {
    if (req.url === '/set-cookie') {
      res.setHeader('Set-Cookie', 'sessionToken=abc123; Path=/');
      res.end('cookie set');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(FIXTURE_HTML);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  let chromeInstance1 = null;
  let chromeInstance2 = null;

  try {
    if (existsSync(TEST_STATE_PATH)) unlinkSync(TEST_STATE_PATH);

    // --- Session 1: set a cookie + localStorage, then save state ---
    console.log('1️⃣  Launching Chrome (session 1)...');
    chromeInstance1 = await launchChrome();
    const { cdpClient: client1, cdpSession: session1, page: page1 } = await attachSession(chromeInstance1.debuggerUrl);
    console.log('   ✓ Session 1 ready\n');

    console.log('2️⃣  Navigating and setting cookie + localStorage...');
    await page1.goto(`${origin}/set-cookie`, { waitUntil: 'domcontentloaded' });
    await page1.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page1.evaluate(() => {
      localStorage.setItem('testKey', 'testValue123');
    });
    console.log('   ✓ Cookie and localStorage set\n');

    console.log('3️⃣  Saving storage state...');
    await saveStorageState(session1, page1, [origin], TEST_STATE_PATH);
    const savedContent = readFileSync(TEST_STATE_PATH, 'utf-8');
    const savedState = JSON.parse(savedContent);

    if (savedState.cookies.some((c: { name: string }) => c.name === 'sessionToken')) {
      console.log(`   ✓ Cookie "sessionToken" present in saved state`);
    } else {
      throw new Error('Cookie not found in saved state');
    }

    const originEntry = savedState.origins.find((o: { origin: string }) => o.origin === origin);
    if (originEntry && originEntry.localStorage.some((e: { name: string; value: string }) => e.name === 'testKey' && e.value === 'testValue123')) {
      console.log(`   ✓ localStorage entry "testKey" present in saved state\n`);
    } else {
      throw new Error('localStorage entry not found in saved state');
    }

    await client1.close();
    await chromeInstance1.close();
    chromeInstance1 = null;

    // --- Session 2: fresh browser, load state, confirm cookie + localStorage present ---
    console.log('4️⃣  Launching Chrome (session 2, fresh profile)...');
    chromeInstance2 = await launchChrome();
    const { cdpClient: client2, cdpSession: session2, page: page2 } = await attachSession(chromeInstance2.debuggerUrl);
    console.log('   ✓ Session 2 ready\n');

    console.log('5️⃣  Loading saved storage state (cookies) before navigation...');
    const loadedState = await loadStorageState(session2, TEST_STATE_PATH);
    console.log(`   ✓ Loaded ${loadedState.cookies.length} cookie(s), ${loadedState.origins.length} origin(s) with localStorage\n`);

    console.log('6️⃣  Navigating to fixture and replaying localStorage...');
    await page2.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await applyOriginLocalStorage(page2, loadedState, origin);
    // Reload so the page's inline script re-reads localStorage after we set it
    await page2.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    console.log('   ✓ Navigated and replayed\n');

    console.log('7️⃣  Verifying cookie arrived via Network.getAllCookies...');
    const cookiesResp = (await session2.send('Network.getAllCookies', {})) as {
      cookies: Array<{ name: string; value: string }>;
    };
    const hasCookie = cookiesResp.cookies.some((c) => c.name === 'sessionToken' && c.value === 'abc123');
    if (hasCookie) {
      console.log('   ✓ Cookie "sessionToken=abc123" present in session 2\n');
    } else {
      throw new Error('Cookie not present in session 2 after load');
    }

    console.log('8️⃣  Verifying localStorage value rendered by the page...');
    const renderedValue = await page2.evaluate(() => document.getElementById('ls-value')?.textContent || '');
    if (renderedValue === 'testValue123') {
      console.log(`   ✓ Page rendered localStorage value: "${renderedValue}"\n`);
    } else {
      throw new Error(`Page rendered "${renderedValue}", expected "testValue123"`);
    }

    await client2.close();

    console.log('✅ Phase C test passed! Storage state save/load round-trips correctly.\n');
    console.log('Summary:');
    console.log('  ✓ saveStorageState() captures cookies + localStorage in Playwright-compatible JSON shape');
    console.log('  ✓ loadStorageState() replays cookies via Network.setCookie before navigation');
    console.log('  ✓ applyOriginLocalStorage() replays localStorage after navigation to the matching origin');
    console.log('  ✓ Round-trip across two independent Chrome processes (fresh profile) preserves both');
  } catch (err) {
    console.error('\n❌ Phase C test failed:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    if (chromeInstance1) await chromeInstance1.close().catch(() => undefined);
    if (chromeInstance2) await chromeInstance2.close().catch(() => undefined);
    server.close();
    if (existsSync(TEST_STATE_PATH)) unlinkSync(TEST_STATE_PATH);
    console.log('\n🧹 Cleanup complete');
  }
}

testPhaseC().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
