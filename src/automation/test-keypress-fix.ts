import { launchChrome } from './chrome-launcher.js';
import { CDPClient } from './cdp-client.js';
import { CDPSession } from './cdp-session.js';
import { PageShim } from './page-shim.js';

async function test() {
  const chromeInstance = await launchChrome();
  const cdpClient = new CDPClient(chromeInstance.debuggerUrl);
  await cdpClient.connect();

  const targetsResp = (await cdpClient.send('Target.getTargets', {})) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  const pageTarget = targetsResp.targetInfos.find((t) => t.type === 'page')!;
  const attachResp = (await cdpClient.send('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  })) as { sessionId: string };

  const session = new CDPSession(cdpClient, attachResp.sessionId, pageTarget.targetId);
  const page = new PageShim(session);
  await page.enable();

  await page.goto('data:text/html,<input id="txt" type="text"><input id="dt" type="date">', {
    waitUntil: 'domcontentloaded',
  });

  // Test 1: plain text input via digit keypresses
  await page.evaluate(() => (document.getElementById('txt') as HTMLInputElement).focus());
  for (const k of ['1', '2', '3']) {
    await page.keyboard.press(k);
  }
  const txtValue = await page.evaluate(() => (document.getElementById('txt') as HTMLInputElement).value);
  console.log('Text input after digit presses:', JSON.stringify(txtValue), txtValue === '123' ? '✓ PASS' : '✗ FAIL');

  // Test 2: native date input segmented editing via digit keypresses
  await page.evaluate(() => (document.getElementById('dt') as HTMLInputElement).focus());
  for (const k of ['1', '2', '3', '1', '2', '0', '2', '6']) {
    await page.keyboard.press(k);
  }
  const dtValue = await page.evaluate(() => (document.getElementById('dt') as HTMLInputElement).value);
  console.log('Date input after digit presses:', JSON.stringify(dtValue), dtValue === '2026-12-31' ? '✓ PASS' : `✗ FAIL (got "${dtValue}")`);

  // Test 3: named keys still work (Escape/Tab/Enter/Backspace)
  await page.evaluate(() => (document.getElementById('txt') as HTMLInputElement).focus());
  await page.keyboard.press('Backspace');
  const afterBackspace = await page.evaluate(() => (document.getElementById('txt') as HTMLInputElement).value);
  console.log('Text input after Backspace:', JSON.stringify(afterBackspace), afterBackspace === '12' ? '✓ PASS' : '✗ FAIL');

  await cdpClient.close();
  await chromeInstance.close();
}

test().catch((err) => {
  console.error(err);
  process.exit(1);
});
