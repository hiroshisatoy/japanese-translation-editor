const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {chromium, expect} = require('@playwright/test');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:8080';
const fixture = (name) => ({name, mimeType: 'text/plain', buffer: Buffer.from([
  'msgid ""', 'msgstr ""',
  '"Project-Id-Version: Export test\\n"', '"Language: ja\\n"',
  '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"', '',
  '# Translator comment', '#. Extracted comment', '#: src/toolbar.js:1',
  'msgctxt "toolbar"', 'msgid "Save"', 'msgstr "保存"', '',
  'msgctxt "footer"', 'msgid "Save"', 'msgstr "保存する"', '',
  '#, fuzzy, c-format', 'msgid "One item"', 'msgid_plural "%s items"',
  'msgstr[0] "1個"', 'msgstr[1] "%s個"', '',
  'msgid "Clear"', 'msgstr "消す"', '',
].join('\n'))});
const area = (page, row, slot = 0) => page.locator(`.row[data-entry="${row}"] textarea.revised`).nth(slot);
const saved = (page) => expect(page.locator('#draft-status')).toHaveAttribute('data-state', /saved|restored/);
const checkbox = (page) => page.getByRole('checkbox', {name: '変更した項目だけを書き出す'});
const openSettings = (page) => page.getByRole('button', {name: '設定', exact: true}).click();
const closeSettings = (page) => page.getByRole('button', {name: '設定を閉じる'}).click();
async function setMode(page, checked) {
  await checkbox(page).setChecked(checked);
  await expect(page.locator('#export-settings-status')).toHaveAttribute('data-state', 'saved');
}
async function exported(page) {
  const promise = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await promise;
  const text = await fs.readFile(await download.path(), 'utf8');
  return {name: download.suggestedFilename(), catalog: await page.evaluate((po) => PoParser.parsePo(po, 'export.po'), text)};
}

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL);
    await openSettings(page);
    await expect(checkbox(page)).not.toBeChecked();
    await checkbox(page).focus();
    await page.keyboard.press('Space');
    await expect(checkbox(page)).toBeChecked();
    await expect(page.locator('#export-settings-status')).toHaveAttribute('data-state', 'saved');
    await expect(page.locator('.storage-details')).toContainText('書き出し設定を保存済み');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: '/tmp/translation-editor-export-settings.png'});
    await closeSettings(page);
    await page.locator('#file').setInputFiles([fixture('edited.po'), fixture('untouched.po')]);
    await saved(page);
    await expect(page.locator('#export')).toBeDisabled();
    await area(page, 0).fill('変更した保存');
    await area(page, 1).fill('一時的な変更');
    await area(page, 1).fill('保存する');
    await area(page, 2, 1).fill('%s 個の変更');
    await area(page, 3).fill('');
    await saved(page);
    await expect(page.locator('#count-changed')).toHaveText('3');
    await page.getByRole('radio', {name: /未翻訳/}).check();
    await page.locator('#q').fill('no matching entries');
    await expect(page.locator('#nomatch')).toBeVisible();
    const downloads = [];
    page.on('download', (download) => downloads.push(download));
    const result = await exported(page);
    assert.equal(downloads.length, 1, 'Do not export unchanged files');
    assert.match(result.name, /^\d{14}_edited_changed\.po$/);
    assert.equal(result.catalog.headers.Language, 'ja');
    assert.equal(result.catalog.headers['Plural-Forms'], 'nplurals=2; plural=(n != 1);');
    assert.equal(result.catalog.entries.length, 3);
    assert.equal(result.catalog.entries[0].context, 'toolbar');
    assert.equal(result.catalog.entries[0].translator, 'Translator comment');
    assert.equal(result.catalog.entries[0].extracted, 'Extracted comment');
    assert.deepEqual(result.catalog.entries[0].references, ['src/toolbar.js:1']);
    assert.deepEqual(result.catalog.entries[1].msgstr, ['1個', '%s 個の変更']);
    assert.deepEqual(result.catalog.entries[1].flags, ['c-format']);
    assert.deepEqual(result.catalog.entries[2].msgstr, ['']);
    await page.reload();
    await saved(page);
    await openSettings(page);
    await expect(checkbox(page)).toBeChecked();
    await closeSettings(page);
    const restored = await exported(page);
    assert.equal(restored.catalog.entries.length, 3);
    await area(page, 0).fill('保存');
    await area(page, 2, 1).fill('%s個');
    await area(page, 3).fill('消す');
    await saved(page);
    await expect(page.locator('#export')).toBeDisabled();

    // Reset only settings: drafts and original files stay intact.
    await area(page, 0).fill('設定削除後も残す下書き');
    await saved(page);
    await openSettings(page);
    await page.evaluate(() => {
      const original = DraftStore.remove;
      DraftStore.remove = () => Promise.reject(new Error('Deletion failed'));
      window.restoreDeletion = () => { DraftStore.remove = original; };
    });
    await page.getByRole('button', {name: '設定情報を削除', exact: true}).click();
    await page.getByRole('button', {name: '削除する', exact: true}).click();
    await expect(page.getByRole('alert')).toContainText('削除できませんでした');
    await expect(checkbox(page)).toBeChecked();
    await saved(page);
    await expect(area(page, 0)).toHaveValue('設定削除後も残す下書き');
    await page.evaluate(() => window.restoreDeletion());
    await page.getByRole('button', {name: '削除する', exact: true}).click();
    await expect(page.getByRole('dialog', {name: '設定情報を削除'})).toBeHidden();
    await expect(checkbox(page)).not.toBeChecked();
    await expect(page.locator('.storage-details')).toContainText('現在は保存していません');
    await closeSettings(page);
    await expect(area(page, 0)).toHaveValue('設定削除後も残す下書き');
    await page.reload();
    await saved(page);
    await openSettings(page);
    await expect(checkbox(page)).not.toBeChecked();
    await closeSettings(page);
    await page.locator('#file').setInputFiles(fixture('edited.po'));
    await saved(page);
    const full = await exported(page);
    assert.equal(full.catalog.entries.length, 4);
    assert.match(full.name, /_All\.po$/);

    // Persistence errors must not change the selected export mode.
    await page.evaluate(() => {
      const original = DraftStore.saveSettings;
      DraftStore.saveSettings = () => Promise.reject(new Error('Storage full'));
      window.restoreSettingsStorage = () => { DraftStore.saveSettings = original; };
    });
    await openSettings(page);
    await checkbox(page).check();
    await expect(page.locator('#export-settings-status')).toHaveAttribute('data-state', 'save-error');
    await closeSettings(page);
    assert.equal((await exported(page)).catalog.entries.length, 1);
    await page.evaluate(() => window.restoreSettingsStorage());
    await openSettings(page);
    await page.getByRole('button', {name: '設定の保存を再試行'}).click();
    await expect(page.locator('#export-settings-status')).toHaveAttribute('data-state', 'saved');
    await setMode(page, false);
    await setMode(page, true);
    await page.getByRole('button', {name: '一時保存をすべて削除', exact: true}).click();
    await page.getByRole('button', {name: '削除して変更を取り消す'}).click();
    await expect(page.getByRole('dialog', {name: '一時保存をすべて削除'})).toBeHidden();
    await expect(checkbox(page)).not.toBeChecked();
    await closeSettings(page);
    await expect(area(page, 0)).toHaveValue('保存');
    assert.deepEqual(errors, []);
    console.log('PASS: changed-only export, header/context/plurals/comments, revert/empty translation, untouched file exclusion, filter independence, persistent/reset settings, failed-save retry, keyboard/mobile');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
