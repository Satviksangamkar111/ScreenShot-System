import { launchChrome } from './chrome-launcher.js';
import { CDPClient } from './cdp-client.js';
import { CDPSession } from './cdp-session.js';
import { PageShim } from './page-shim.js';

const FIXTURE = `
<style>body { font: 14px sans-serif; }</style>
<div id="sap-ui-static">
  <div id="__dialog0" class="sapMDialog sapMDialog-CTX sapMPopup-CTX sapUiShd" role="dialog"
       style="width:400px; height:200px; position:fixed; top:100px; left:100px; z-index:100;">
    <header class="sapMDialogTitleGroup">
      <h1 class="sapMDialogTitle">Customer Category</h1>
    </header>
    <section id="__dialog0-cont" class="sapMDialogSection" style="height:100px;">
      <div id="__dialog0-scroll" class="sapMDialogScroll" style="height:100px;">
        <div id="__dialog0-scrollCont" class="sapMDialogScrollCont" style="height:100px;">
          <div id="__list69" class="sapMList sapMListBGSolid" role="presentation" style="height:100px;">
            <ul id="__list69-listUl" class="sapMListUl" role="listbox" style="height:100px;">
              <li id="__item28" class="sapMLIB sapMSLI" role="option" style="height:48px; display:block;">
                <div id="__item28-content" class="sapMLIBContent" style="height:48px;">
                  <div class="sapMSLIDiv sapMSLITitleDiv" style="height:21px;">
                    <div class="sapMSLITitleOnly" style="height:21px;">Organization</div>
                  </div>
                </div>
              </li>
              <li id="__item27" class="sapMLIB sapMSLI" role="option" style="height:48px; display:block;">
                <div id="__item27-content" class="sapMLIBContent" style="height:48px;">
                  <div class="sapMSLIDiv sapMSLITitleDiv" style="height:21px;">
                    <div class="sapMSLITitleOnly" style="height:21px;">Person</div>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
    <footer class="sapMDialogFooter" style="height:40px;">
      <button id="__button21" class="sapMBarChild sapMBtn sapMBtnBase" style="height:36px; width:80px;">Cancel</button>
    </footer>
  </div>
</div>
`;

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  if (ok) pass++; else fail++;
}

async function main() {
  const chrome = await launchChrome();
  const client = new CDPClient(chrome.debuggerUrl);
  await client.connect();

  const targets = (await client.send('Target.getTargets', {})) as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  const target = targets.targetInfos.find((t) => t.type === 'page')!;
  const attach = (await client.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })) as { sessionId: string };

  const session = new CDPSession(client, attach.sessionId, target.targetId);
  const page = new PageShim(session);
  await page.enable();

  await page.goto('data:text/html,' + encodeURIComponent(FIXTURE), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Direct evaluate test — see what's visible.
  console.log('\n0) Direct DOM check');
  const directCheck = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('.sapMDialog, [role="dialog"], dialog[open]');
    const results: any[] = [];
    dialogs.forEach((d) => {
      const r = (d as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(d as HTMLElement);
      results.push({
        id: d.id,
        role: d.getAttribute('role'),
        w: Math.round(r.width), h: Math.round(r.height),
        display: s.display, visibility: s.visibility,
        visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none',
      });
    });
    return results;
  });
  console.log('  dialogs found:', JSON.stringify(directCheck));

  console.log('\n1) inspectTopDialog');
  try {
    const { inspectTopDialog } = await import('../interaction/dialogs.js');
    const dialog = await inspectTopDialog(page);
    console.log('  result:', JSON.stringify(dialog));
    check('dialog found', !!dialog, true);
    if (dialog) {
      check('title', dialog.title, 'Customer Category');
      check('not a message', dialog.isMessage, false);
      check('option count', dialog.options.length, 2);
      const labels = dialog.options.map((o) => o.label);
      check('has Organization', labels.includes('Organization'), true);
      check('has Person', labels.includes('Person'), true);
    }
  } catch (e) {
    console.log('  ERROR:', e);
    fail += 6;
  }

  console.log('\n2) chooseOption("Organization")');
  try {
    const { chooseOption } = await import('../interaction/dialogs.js');
    const orgResult = await chooseOption(page, 'Organization', 5000);
    check('click succeeded', orgResult, true);
  } catch (e) {
    console.log('  ERROR:', e);
    fail++;
  }

  // Reload and try Person.
  await page.goto('data:text/html,' + encodeURIComponent(FIXTURE), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  console.log('\n3) chooseOption("Person")');
  try {
    const { chooseOption } = await import('../interaction/dialogs.js');
    const personResult = await chooseOption(page, 'Person', 5000);
    check('click succeeded', personResult, true);
  } catch (e) {
    console.log('  ERROR:', e);
    fail++;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);

  await client.close();
  await chrome.close();
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
