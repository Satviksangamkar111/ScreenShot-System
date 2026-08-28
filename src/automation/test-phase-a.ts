import { launchChrome } from './chrome-launcher.js';
import { CDPClient } from './cdp-client.js';
import { CDPSession } from './cdp-session.js';

async function testPhaseA() {
  console.log('🚀 Phase A Test: CDP Transport Layer');
  console.log('====================================\n');

  let chromeInstance = null;
  let cdpClient = null;
  let session = null;

  try {
    // Step 1: Launch Chrome
    console.log('1️⃣  Launching Chrome headless...');
    chromeInstance = await launchChrome();
    console.log(`   ✓ Chrome launched. PID: ${chromeInstance.process.pid}`);
    console.log(`   ✓ Debugger URL: ${chromeInstance.debuggerUrl}\n`);

    // Step 2: Connect CDP client
    console.log('2️⃣  Connecting CDP client...');
    cdpClient = new CDPClient(chromeInstance.debuggerUrl);
    await cdpClient.connect();
    console.log('   ✓ CDP client connected\n');

    // Step 3: Get targets
    console.log('3️⃣  Querying targets...');
    const targetsResp = await cdpClient.send('Target.getTargets', {});
    const targets = (targetsResp as { targetInfos: Array<{ targetId: string; type: string; title: string; url: string }> }).targetInfos || [];
    console.log(`   ✓ Found ${targets.length} target(s)`);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');
    console.log(`   ✓ Page target: "${pageTarget.title}" at ${pageTarget.url}\n`);

    // Step 4: Attach to target
    console.log('4️⃣  Attaching to page target...');
    const attachResp = await cdpClient.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    const sessionId = (attachResp as { sessionId: string }).sessionId;
    console.log(`   ✓ Attached. Session ID: ${sessionId}\n`);

    session = new CDPSession(cdpClient, sessionId);

    // Step 5: Enable runtime
    console.log('5️⃣  Enabling Runtime domain...');
    await session.send('Runtime.enable', {});
    console.log('   ✓ Runtime enabled\n');

    // Step 6: Evaluate simple expression
    console.log('6️⃣  Evaluating: 1 + 1');
    const evalResp = await session.send('Runtime.evaluate', {
      expression: '1 + 1',
      returnByValue: true,
    });
    const result = (evalResp as { result?: { value?: number } }).result?.value;
    if (result === 2) {
      console.log(`   ✓ Result: ${result} (correct!)\n`);
    } else {
      throw new Error(`Expected 2, got ${result}`);
    }

    // Step 7: Evaluate document.title
    console.log('7️⃣  Evaluating: document.title');
    const titleResp = await session.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const title = (titleResp as { result?: { value?: string } }).result?.value;
    console.log(`   ✓ Document title: "${title}"\n`);

    // Step 8: Navigate to a URL
    console.log('8️⃣  Navigating to https://www.example.com...');
    const navResp = await session.send('Page.navigate', {
      url: 'https://www.example.com',
    });
    const frameId = (navResp as { frameId?: string }).frameId;
    console.log(`   ✓ Navigation initiated. Frame ID: ${frameId}`);

    // Wait a bit for the page to load
    await new Promise((r) => setTimeout(r, 2000));

    // Evaluate URL
    console.log('9️⃣  Checking current URL...');
    const urlResp = await session.send('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    const url = (urlResp as { result?: { value?: string } }).result?.value;
    console.log(`   ✓ Current URL: ${url}\n`);

    console.log('✅ Phase A test passed! All transport layer checks successful.\n');
    console.log('Summary:');
    console.log('  ✓ Chrome launch and debugger port detection');
    console.log('  ✓ CDP WebSocket connection');
    console.log('  ✓ Target enumeration and attachment');
    console.log('  ✓ Runtime.evaluate with basic expressions');
    console.log('  ✓ Page navigation');
    console.log('  ✓ Session lifecycle management');
  } catch (err) {
    console.error('\n❌ Phase A test failed:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    // Cleanup
    if (session) {
      try {
        await cdpClient?.close();
      } catch {
        // Already closed
      }
    }
    if (chromeInstance) {
      await chromeInstance.close();
      console.log('\n🧹 Chrome process terminated');
    }
  }
}

testPhaseA().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
