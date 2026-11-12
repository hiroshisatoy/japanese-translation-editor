import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, SearchControl, Modal } from '@wordpress/components';
import { Field, Fieldset, Radio, RadioGroup, Stack, useEnableWpCompatOverlaySlot } from '@wordpress/ui';
import { close, cog } from '@wordpress/icons';
import '@wordpress/components/build-style/style.css';
import '@wordpress/theme/design-tokens.css';

// Mount controls before app.js binds the catalog and virtual-list handlers.
function mount(id, content) {
  flushSync(() => createRoot(document.getElementById(id)).render(content));
}

function Search() {
  const [value, setValue] = useState('');
  useLayoutEffect(() => {
    const reset = () => flushSync(() => setValue(''));
    document.addEventListener('translation-reset-controls', reset);
    return () => document.removeEventListener('translation-reset-controls', reset);
  }, []);
  return <SearchControl id="q" name="q" label="翻訳を検索" value={value}
    placeholder="例: 保存　原文:Settings" spellCheck={false}
    autoCapitalize="none" enterKeyHint="search" aria-controls="window"
    onChange={(next) => {
      flushSync(() => setValue(next));
      document.dispatchEvent(new Event('translation-search'));
    }} />;
}
const statuses = [
  ['all', 'すべて'], ['untranslated', '未翻訳'], ['fuzzy', '要確認'],
  ['translated', '翻訳済み'], ['changed', '変更あり'],
];
function Filters() {
  const [selected, setSelected] = useState('all');
  useLayoutEffect(() => {
    const reset = () => flushSync(() => setSelected('all'));
    document.addEventListener('translation-reset-controls', reset);
    return () => document.removeEventListener('translation-reset-controls', reset);
  }, []);
  return <Field.Root name="status" className="status-control">
    <Fieldset.Root render={<RadioGroup render={<Stack direction="row" wrap="wrap" gap="lg" />} value={selected} onValueChange={(next) => {
      flushSync(() => setSelected(next));
      document.dispatchEvent(new Event('translation-search'));
    }} />}>
      <Fieldset.Legend hideFromVision>翻訳の状態</Fieldset.Legend>
      {statuses.map(([value, label]) => <Field.Item className="status-option" key={value}>
        <Radio value={value} data-status={value} />
        <Field.Label variant="plain">{label} <span className="count" id={`count-${value}`} /></Field.Label>
      </Field.Item>)}
    </Fieldset.Root>
  </Field.Root>;
}
function Help() {
  const [open, setOpen] = useState(false);
  return <><Button variant="tertiary" onClick={() => setOpen(true)}>検索の書き方</Button>
    {open && <Modal title="検索の書き方" onRequestClose={() => setOpen(false)}>
      <p>半角スペースで区切ると、すべての語句を含む翻訳を検索します。引用符で句をまとめられます。</p>
      <p>検索する範囲を指定できます。</p>
      <dl>{[['原文:', '英語の原文'], ['訳文:', '取り込んだ訳文'], ['変更:', '編集した訳文'],
        ['文脈:', '文字列の文脈'], ['参照:', '参照ファイル']].map(([key, text]) =>
        <div key={key}><dt><code>{key}</code></dt><dd>{text}</dd></div>)}</dl>
      <p>例: <code>原文:Settings</code> / <code>訳文:"変更を保存"</code></p>
      <Button variant="primary" onClick={() => setOpen(false)}>閉じる</Button>
    </Modal>}
  </>;
}
function useDraftStatus() {
  const [status, setStatus] = useState({state: 'loading', message: '一時保存を確認しています', canClear: false});
  useLayoutEffect(() => {
    const update = (event) => setStatus(event.detail);
    document.addEventListener('translation-draft-status', update);
    return () => document.removeEventListener('translation-draft-status', update);
  }, []);
  return status;
}
function DraftStatus() {
  useEnableWpCompatOverlaySlot();
  const status = useDraftStatus();
  return <p id="draft-status" className="draft-error" role="status" data-state={status.state}
    hidden={status.state !== 'error'}>{status.message}</p>;
}
function Settings() {
  const status = useDraftStatus();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null);
  const settingsDialog = useRef(null);
  const confirmDialog = useRef(null);
  useLayoutEffect(() => {
    const update = (event) => setInfo(event.detail);
    document.addEventListener('translation-draft-info', update);
    return () => document.removeEventListener('translation-draft-info', update);
  }, []);
  useEffect(() => {
    if (!open) return;
    setInfo(null);
    document.dispatchEvent(new Event('translation-request-draft-info'));
  }, [open, status.state, status.message]);
  const summary = info?.summary;
  const canClear = Boolean(summary && (summary.files || summary.changes));
  return <>
    <Button id="settings" variant="tertiary" icon={cog} label="設定" showTooltip __next40pxDefaultSize
      onClick={() => { settingsDialog.current.showModal(); setOpen(true); }} />
    <dialog ref={settingsDialog} className="settings-dialog" aria-labelledby="settings-title" onClose={() => setOpen(false)}>
      <div className="settings-heading"><h2 id="settings-title">設定</h2>
        <form method="dialog"><Button variant="tertiary" icon={close} label="設定を閉じる" __next40pxDefaultSize type="submit" autoFocus /></form>
      </div>
      <section aria-labelledby="storage-title">
        <h3 id="storage-title">一時保存</h3>
        <p>ファイルと下書きをこのブラウザーに自動保存します。</p>
        <dl className="storage-details">
          <div><dt>保存状態</dt><dd>{status.message}</dd></div>
          <div><dt>保存したファイル</dt><dd>{summary ? `${summary.files.toLocaleString('ja-JP')} 件` : info?.error ? '確認できません' : '確認中…'}</dd></div>
          <div><dt>保存した下書き</dt><dd>{summary ? `${summary.changes.toLocaleString('ja-JP')} 件` : info?.error ? '確認できません' : '確認中…'}</dd></div>
        </dl>
        <Button variant="secondary" isDestructive disabled={!canClear}
          onClick={() => confirmDialog.current.showModal()}>一時保存をすべて削除</Button>
      </section>
    </dialog>
    <dialog ref={confirmDialog} aria-labelledby="clear-drafts-title">
      <h2 id="clear-drafts-title">一時保存をすべて削除</h2>
      <p>このブラウザーに保存したファイルと下書きを削除し、開いているファイルの変更を取り消します。</p>
      <p>次に編集すると自動保存を再開します。書き出した PO ファイルはそのまま残ります。</p>
      <form method="dialog" className="draft-dialog-actions">
        <Button variant="secondary" type="submit" autoFocus>キャンセル</Button>
        <Button variant="primary" isDestructive type="submit" onClick={() => {
          document.dispatchEvent(new Event('translation-clear-drafts'));
        }}>削除して変更を取り消す</Button>
      </form>
    </dialog>
  </>;
}
function Actions() {
  const [warning, setWarning] = useState(false);
  const dialog = useRef(null);
  useLayoutEffect(() => {
    const showWarning = () => setWarning(true);
    document.addEventListener('translation-close-warning', showWarning);
    return () => document.removeEventListener('translation-close-warning', showWarning);
  }, []);
  useEffect(() => {
    if (warning && !dialog.current.open) dialog.current.showModal();
  }, [warning]);
  return <>
  <Button id="export" variant="secondary" aria-label="変更を書き出す" disabled __next40pxDefaultSize>
    <span className="action-full" aria-hidden="true">変更を書き出す</span><span className="action-short" aria-hidden="true">書き出す</span>
  </Button>
  <Button id="open-file" variant="primary" aria-label="PO を開く" __next40pxDefaultSize onClick={() => document.getElementById('file').click()}>
    <span className="action-full" aria-hidden="true">PO を開く</span><span className="action-short" aria-hidden="true">開く</span>
  </Button>
  <Settings />
  <Button id="close-file" variant="tertiary" icon={close} label="ファイルを閉じる" showTooltip disabled __next40pxDefaultSize />
  <dialog ref={dialog} aria-labelledby="close-warning-title" onClose={() => setWarning(false)}>
    <h2 id="close-warning-title">下書きを保存できませんでした</h2>
    <p>このまま閉じると、保存できていない変更が失われます。変更を残すには、戻って PO ファイルを書き出してください。</p>
    <form method="dialog" className="draft-dialog-actions">
      <Button variant="secondary" type="submit" autoFocus>戻る</Button>
      <Button variant="primary" isDestructive type="submit" onClick={() => {
        document.dispatchEvent(new Event('translation-force-close'));
      }}>変更を破棄して閉じる</Button>
    </form>
  </dialog>
  </>;
}
mount('wp-actions', <Actions />);
mount('wp-search', <Search />);
mount('wp-submit', <Button type="submit" variant="secondary" __next40pxDefaultSize>検索</Button>);
mount('wp-filters', <Filters />);
mount('wp-help', <Help />);
mount('wp-sample', <div className="empty-actions">
  <Button id="open-empty" variant="primary" __next40pxDefaultSize onClick={() => document.getElementById('file').click()}>PO ファイルを開く</Button>
  <Button id="sample" variant="secondary" __next40pxDefaultSize>見本を表示</Button>
</div>);
mount('wp-drafts', <DraftStatus />);
