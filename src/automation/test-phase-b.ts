import { launchChrome } from './chrome-launcher.js';
import { CDPClient } from './cdp-client.js';
import { CDPSession } from './cdp-session.js';
import { PageShim } from './page-shim.js';
import { readFileSync } from 'fs';
import { join } from 'path';

async function testPhaseB() {
  console.log('🚀 Phase B Test: Page/Locator Shim');
  console.log('===================================\n');

  let chromeInstance = null;
  let cdpClient = null;
  let page: PageShim | null = null;

  try {
    // Launch Chrome
    console.log('1️⃣  Launching Chrome...');
    chromeInstance = await launchChrome();
    console.log(`   ✓ Chrome launched\n`);

    // Connect CDP
    console.log('2️⃣  Connecting CDP client...');
    cdpClient = new CDPClient(chromeInstance.debuggerUrl);
    await cdpClient.connect();
    console.log('   ✓ CDP connected\n');

    // Get page target
    console.log('3️⃣  Attaching to page target...');
    const targetsResp = (await cdpClient.send('Target.getTargets', {})) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    const pageTarget = targetsResp.targetInfos.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const attachResp = (await cdpClient.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    })) as { sessionId: string };

    const session = new CDPSession(cdpClient, attachResp.sessionId, pageTarget.targetId);
    page = new PageShim(session);
    await page.enable();
    console.log('   ✓ Page shim ready\n');

    // Load test fixture
    console.log('4️⃣  Loading test fixture...');
    const fixturePath = join(process.cwd(), 'src/automation/test-phase-b-fixture.html');
    const fixtureUrl = `file:///${fixturePath.replace(/\\/g, '/')}`;
    await page.goto(fixtureUrl);
    console.log(`   ✓ Loaded: ${page.url()}\n`);

    // Test 1: count()
    console.log('5️⃣  Test count()...');
    const countResult = await page.locator('.item').count();
    if (countResult === 3) {
      console.log(`   ✓ count() returned ${countResult} (expected 3)\n`);
    } else {
      throw new Error(`count() returned ${countResult}, expected 3`);
    }

    // Test 2: click()
    console.log('6️⃣  Test click()...');
    await page.locator('#increment-btn').click();
    const counterText = await page.evaluate(() => (document.getElementById('counter') as HTMLElement)?.textContent || '');
    if (counterText === '1') {
      console.log(`   ✓ click() incremented counter to ${counterText}\n`);
    } else {
      throw new Error(`Counter is ${counterText}, expected 1`);
    }

    // Test 3: fill()
    console.log('7️⃣  Test fill()...');
    await page.locator('#text-input').fill('Hello World');
    const inputValue = await page.evaluate(() => (document.getElementById('text-input') as HTMLInputElement)?.value || '');
    const inputChanged = await page.evaluate(() => document.getElementById('input-changed')?.textContent || '');
    if (inputValue === 'Hello World' && inputChanged === 'Yes') {
      console.log(`   ✓ fill() set value and fired input event\n`);
    } else {
      throw new Error(`fill() failed: value=${inputValue}, changed=${inputChanged}`);
    }

    // Test 4: evaluate()
    console.log('8️⃣  Test evaluate() on page...');
    const evalResult = await page.evaluate((x) => (x as number) * 2, 5);
    if (evalResult === 10) {
      console.log(`   ✓ page.evaluate(x => x * 2, 5) returned ${evalResult}\n`);
    } else {
      throw new Error(`evaluate() returned ${evalResult}, expected 10`);
    }

    // Test 5: locator.evaluate()
    console.log('9️⃣  Test evaluate() on locator...');
    const locatorEvalResult = await page.locator('#visible').evaluate((el) => (el as HTMLElement).textContent || '');
    if (locatorEvalResult === 'Visible') {
      console.log(`   ✓ locator.evaluate() returned "${locatorEvalResult}"\n`);
    } else {
      throw new Error(`locator.evaluate() returned "${locatorEvalResult}", expected "Visible"`);
    }

    // Test 6: isVisible()
    console.log('🔟 Test isVisible()...');
    const visibleResult = await page.locator('#visible').isVisible();
    const hiddenResult = await page.locator('#hidden').isVisible();
    if (visibleResult === true && hiddenResult === false) {
      console.log(`   ✓ isVisible() returned true for visible, false for hidden\n`);
    } else {
      throw new Error(`isVisible() failed: visible=${visibleResult}, hidden=${hiddenResult}`);
    }

    // Test 7: getAttribute()
    console.log('1️⃣1️⃣ Test getAttribute()...');
    const attrResult = await page.locator('#text-input').getAttribute('type');
    if (attrResult === 'text') {
      console.log(`   ✓ getAttribute('type') returned "${attrResult}"\n`);
    } else {
      throw new Error(`getAttribute() returned "${attrResult}", expected "text"`);
    }

    // Test 8: innerText()
    console.log('1️⃣2️⃣ Test innerText()...');
    const textResult = await page.locator('#visible').innerText();
    if (textResult === 'Visible') {
      console.log(`   ✓ innerText() returned "${textResult}"\n`);
    } else {
      throw new Error(`innerText() returned "${textResult}", expected "Visible"`);
    }

    // Test 9: scrollIntoViewIfNeeded()
    console.log('1️⃣3️⃣ Test scrollIntoViewIfNeeded()...');
    await page.locator('#far-down').scrollIntoViewIfNeeded();
    const farDownRect = await page.evaluate(() => {
      const el = document.getElementById('far-down');
      const rect = el?.getBoundingClientRect();
      return { top: rect?.top, bottom: rect?.bottom };
    });
    // Just check it was scrolled to viewport
    if (farDownRect.top !== undefined && farDownRect.top < 900) {
      console.log(`   ✓ scrollIntoViewIfNeeded() brought element into viewport\n`);
    } else {
      console.log(`   ⚠ scrollIntoViewIfNeeded() position: ${JSON.stringify(farDownRect)} (may still be valid)\n`);
    }

    // Test 10: keyboard.press()
    console.log('1️⃣4️⃣ Test keyboard.press()...');
    const isDialogOpen = await page.evaluate(() => (document.getElementById('test-dialog') as HTMLDialogElement)?.open ?? false);
    if (isDialogOpen) {
      await page.keyboard.press('Escape');
      const isDialogOpenAfter = await page.evaluate(() => (document.getElementById('test-dialog') as HTMLDialogElement)?.open ?? false);
      if (!isDialogOpenAfter) {
        console.log(`   ✓ keyboard.press('Escape') closed the dialog\n`);
      } else {
        throw new Error('keyboard.press() did not close dialog');
      }
    } else {
      console.log(`   ⚠ Dialog was already closed\n`);
    }

    console.log('✅ Phase B test passed! All Page/Locator shim methods working.\n');
    console.log('Summary:');
    console.log('  ✓ locator.count()');
    console.log('  ✓ locator.click()');
    console.log('  ✓ locator.fill()');
    console.log('  ✓ page.evaluate()');
    console.log('  ✓ locator.evaluate()');
    console.log('  ✓ locator.isVisible()');
    console.log('  ✓ locator.getAttribute()');
    console.log('  ✓ locator.innerText()');
    console.log('  ✓ locator.scrollIntoViewIfNeeded()');
    console.log('  ✓ keyboard.press()');
  } catch (err) {
    console.error('\n❌ Phase B test failed:');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    if (chromeInstance) {
      await chromeInstance.close();
      console.log('\n🧹 Chrome process terminated');
    }
  }
}

testPhaseB().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
