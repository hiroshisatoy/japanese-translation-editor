const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8080';

function fixture(name, project = name) {
  return {
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from([
      'msgid ""', 'msgstr ""',
      `"Project-Id-Version: ${project}\\n"`,
      '"Language: ja\\n"',
      '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"', '',
      'msgctxt "toolbar"', 'msgid "Save"', 'msgstr "保存"', '',
      'msgctxt "footer"', 'msgid "Save"', 'msgstr "保存する"', '',
      'msgid "One item"', 'msgid_plural "%s items"',
      'msgstr[0] "1個"', 'msgstr[1] "%s個"', '',
    ].join('\n')),
  };
}

function area(page, row, slot = 0) {
  return page.locator(`.row[data-entry="${row}"] textarea.revised`).nth(slot);
}
async function saved(page) {
  await expect(page.locator('#draft-status')).toHaveAttribute('data-state', /saved|restored/);
}
async function load(page, files) {
  await page.locator('#file').setInputFiles(files);
  await saved(page);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    let page = await context.newPage();
    await page.goto(baseURL);
    await expect(page.locator('#draft-status')).toHaveAttribute('data-state', 'ready');
    const alpha = fixture('alpha.po');
    const beta = fixture('beta.po');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', {name: 'PO ファイルを開く', exact: true}).click();
    const chooser = await chooserPromise;
    await chooser.setFiles([alpha, beta]);
    await saved(page);
    await expect(page.locator('#count-all')).toHaveText('6');
    await area(page, 0).fill('ツールバーの下書き');
    await area(page, 1).fill('');
    await area(page, 2, 1).fill('%s 個の下書き');
    await area(page, 3).fill('別ファイルの下書き');
    await saved(page);
    await expect(page.locator('#count-changed')).toHaveText('4');
    await page.reload();
    await saved(page);
    await expect(area(page, 0)).toHaveValue('ツールバーの下書き');
    await expect(area(page, 1)).toHaveValue('');
    await expect(area(page, 2, 1)).toHaveValue('%s 個の下書き');
    await expect(area(page, 3)).toHaveValue('別ファイルの下書き');
    await expect(area(page, 4)).toHaveValue('保存する');
    await expect(page.locator('#count-changed')).toHaveText('4');
    await page.getByRole('radio', {name: /変更あり/}).check();
    await expect(page.locator('.row')).toHaveCount(4);
    await page.getByRole('radio', {name: /すべて/}).check();
    const downloads = [];
    page.on('download', (download) => downloads.push(download));
    await page.locator('#export').click();
    await expect.poll(() => downloads.length).toBe(2);
    assert.match(downloads[0].suggestedFilename(), /^\d{14}_alpha_All\.po$/);
    assert.match(downloads[1].suggestedFilename(), /^\d{14}_beta_All\.po$/);
    assert.equal(downloads[0].suggestedFilename().slice(0, 14), downloads[1].suggestedFilename().slice(0, 14));
    const exported = await fs.readFile(await downloads[0].path(), 'utf8');
    assert.ok(exported.includes('msgstr "ツールバーの下書き"'));
    assert.ok(exported.includes('msgstr[1] "%s 個の下書き"'));
    assert.ok(!exported.includes('別ファイルの下書き'));

    // Closing and reopening a tab also restores the files, without reselecting them.
    await page.close();
    page = await context.newPage();
    await page.goto(baseURL);
    await saved(page);
    await expect(area(page, 3)).toHaveValue('別ファイルの下書き');
    await expect(page.locator('#count-changed')).toHaveText('4');

    // Same name + different content, or different name + same content, are isolated.
    await load(page, fixture('alpha.po', 'updated catalog'));
    await expect(area(page, 0)).toHaveValue('保存');
    await expect(page.locator('#count-changed')).toHaveText('0');
    await load(page, {...alpha, name: 'renamed.po'});
    await expect(area(page, 0)).toHaveValue('保存');
    await load(page, alpha);
    await expect(area(page, 0)).toHaveValue('ツールバーの下書き');
    await expect(page.locator('#count-changed')).toHaveText('3');
    await area(page, 0).fill('保存');
    await saved(page);
    await page.reload();
    await saved(page);
    await expect(area(page, 0)).toHaveValue('保存');
    await expect(page.locator('#count-changed')).toHaveText('2');

    // Cancel leaves drafts intact; confirm removes every saved catalog and draft.
    await page.getByRole('button', {name: '一時保存をすべて削除', exact: true}).click();
    await page.getByRole('button', {name: 'キャンセル', exact: true}).click();
    await expect(page.locator('#count-changed')).toHaveText('2');
    await page.getByRole('button', {name: '一時保存をすべて削除', exact: true}).click();
    await page.getByRole('button', {name: '削除して変更を取り消す', exact: true}).click();
    await saved(page);
    await expect(area(page, 1)).toHaveValue('保存する');
    await expect(page.locator('#count-changed')).toHaveText('0');
    const sizes = await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('japanese-translation-editor-drafts', 1);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        return await Promise.all(['catalogs', 'drafts', 'meta'].map((name) => new Promise((resolve) => {
          const request = db.transaction(name).objectStore(name).count();
          request.onsuccess = () => resolve(request.result);
        })));
      } finally { db.close(); }
    });
    assert.deepEqual(sizes, [0, 0, 0]);
    // The next edit re-enables saving, including the baseline removed above.
    await area(page, 0).fill('削除後の新しい下書き');
    await saved(page);
    await page.reload();
    await saved(page);
    await expect(area(page, 0)).toHaveValue('削除後の新しい下書き');
    await page.setViewportSize({width: 390, height: 844});
    await page.reload();
    await saved(page);
    await expect(area(page, 0)).toHaveValue('削除後の新しい下書き');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: '/tmp/translation-editor-drafts-mobile.png'});
    await load(page, fixture('日本語.POT'));
    const potDownload = page.waitForEvent('download');
    await page.locator('#export').click();
    assert.match((await potDownload).suggestedFilename(), /^\d{14}_日本語_All\.po$/);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS: reload/tab recovery, multiple files, contexts/plurals/empty values, file identity, export, revert, deletion, mobile');

    // A failed transaction must not be reported as saved; later edits retry all changes.
    const retryContext = await browser.newContext();
    const retry = await retryContext.newPage();
    await retry.goto(baseURL);
    await expect(retry.locator('#draft-status')).toHaveAttribute('data-state', 'ready');
    await load(retry, alpha);
    await retry.evaluate(() => {
      window.originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(names, mode, ...rest) {
        const tx = window.originalTransaction.call(this, names, mode, ...rest);
        if (mode === 'readwrite' && names.includes('drafts')) queueMicrotask(() => tx.abort());
        return tx;
      };
    });
    await area(retry, 0).fill('保存失敗後の復旧');
    await expect(retry.locator('#draft-status')).toHaveAttribute('data-state', 'error');
    await expect(area(retry, 0)).toHaveValue('保存失敗後の復旧');
    await retry.evaluate(() => { IDBDatabase.prototype.transaction = window.originalTransaction; });
    await area(retry, 1).fill('別の行も復旧');
    await saved(retry);
    await retry.reload();
    await saved(retry);
    await expect(area(retry, 0)).toHaveValue('保存失敗後の復旧');
    await expect(area(retry, 1)).toHaveValue('別の行も復旧');
    await retryContext.close();
    console.log('PASS: aborted transaction, error indication, full retry');

    const baselineContext = await browser.newContext();
    const baselinePage = await baselineContext.newPage();
    await baselinePage.goto(baseURL);
    await expect(baselinePage.locator('#draft-status')).toHaveAttribute('data-state', 'ready');
    await baselinePage.evaluate(() => {
      window.originalRemember = DraftStore.remember;
      DraftStore.remember = () => new Promise((resolve, reject) => {
        window.failBaseline = () => reject(new DOMException('Full', 'QuotaExceededError'));
      });
    });
    await baselinePage.locator('#file').setInputFiles(alpha);
    await expect(baselinePage.locator('#catalog')).toContainText('alpha.po');
    await area(baselinePage, 0).fill('元ファイルの保存待ち');
    await expect(baselinePage.locator('#draft-status')).toHaveAttribute('data-state', 'saving');
    await baselinePage.evaluate(() => window.failBaseline());
    await expect(baselinePage.locator('#draft-status')).toHaveAttribute('data-state', 'error');
    await baselinePage.evaluate(() => { DraftStore.remember = window.originalRemember; });
    await area(baselinePage, 1).fill('再試行で復旧');
    await saved(baselinePage);
    await baselinePage.reload();
    await saved(baselinePage);
    await expect(area(baselinePage, 0)).toHaveValue('元ファイルの保存待ち');
    await expect(area(baselinePage, 1)).toHaveValue('再試行で復旧');
    await baselineContext.close();
    console.log('PASS: failed baseline cannot be reported as saved, retry restores complete session');

    const blocked = await browser.newContext();
    await blocked.addInitScript(() => {
      IDBFactory.prototype.open = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    const blockedPage = await blocked.newPage();
    await blockedPage.goto(baseURL);
    await expect(blockedPage.locator('#draft-status')).toHaveAttribute('data-state', 'error');
    await blockedPage.locator('#sample').click();
    await expect(area(blockedPage, 0)).toBeVisible();
    await expect(blockedPage.locator('#draft-status')).toHaveAttribute('data-state', 'error');
    await area(blockedPage, 0).fill('保存不可でも編集できる');
    const downloadPromise = blockedPage.waitForEvent('download');
    await blockedPage.locator('#export').click();
    const download = await downloadPromise;
    const text = await fs.readFile(await download.path(), 'utf8');
    assert.ok(text.includes('保存不可でも編集できる'));
    await blocked.close();
    console.log('PASS: blocked storage preserves editing and PO export');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
