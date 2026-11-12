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
  const [scope, setScope] = useState('all');
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const settingsDialog = useRef(null);
  const confirmDialog = useRef(null);
  const settingsClose = useRef(null);
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
  const categories = {
    current: {
      title: '現在開いているファイルを削除',
      description: '開いているファイルの一時保存と下書きを削除し、画面の変更を取り込んだ訳文に戻します。次に編集すると自動保存を再開します。',
    },
    other: {
      title: 'ほかの保存済みファイルを削除',
      description: '現在開いていないファイルと、その下書きを削除します。開いているファイルとその変更は残ります。',
    },
    drafts: {
      title: '下書きだけを削除',
      description: 'すべてのファイルの下書きを削除し、開いているファイルの変更を取り込んだ訳文に戻します。ファイル自体は残ります。',
    },
    all: {
      title: '一時保存をすべて削除',
      description: '保存したすべてのファイルと下書きを削除し、開いているファイルの変更を取り込んだ訳文に戻します。次に編集すると自動保存を再開します。',
    },
  };
  const askDelete = (nextScope) => {
    flushSync(() => { setScope(nextScope); setDeleteError(false); });
    confirmDialog.current.showModal();
  };
  const deleteData = async () => {
    setBusy(true);
    setDeleteError(false);
    const success = await new Promise((complete) => {
      document.dispatchEvent(new CustomEvent('translation-delete-drafts', {detail: {scope, complete}}));
    });
    setBusy(false);
    if (success) {
      confirmDialog.current.close();
      // The invoking deletion control can become disabled after the refresh.
      settingsClose.current.focus();
      setInfo(null);
      document.dispatchEvent(new Event('translation-request-draft-info'));
    } else {
      setDeleteError(true);
    }
  };
  return <>
    <Button id="settings" variant="tertiary" icon={cog} label="設定" showTooltip __next40pxDefaultSize
      onClick={() => { settingsDialog.current.showModal(); setOpen(true); }} />
    <dialog ref={settingsDialog} className="settings-dialog" aria-labelledby="settings-title" onClose={() => setOpen(false)}>
      <div className="settings-heading"><h2 id="settings-title">設定</h2>
        <form method="dialog"><Button ref={settingsClose} variant="tertiary" icon={close} label="設定を閉じる" __next40pxDefaultSize type="submit" autoFocus /></form>
      </div>
      <section aria-labelledby="storage-title">
        <h3 id="storage-title">一時保存</h3>
        <p>ファイルと下書きをこのブラウザーに自動保存します。</p>
        <dl className="storage-details">
          <div><dt>保存状態</dt><dd>{status.message}</dd></div>
          <div><dt>保存したファイル</dt><dd>{summary ? `${summary.files.toLocaleString('ja-JP')} 件` : info?.error ? '確認できません' : '確認中…'}</dd></div>
          <div><dt>保存した下書き</dt><dd>{summary ? `${summary.changes.toLocaleString('ja-JP')} 件` : info?.error ? '確認できません' : '確認中…'}</dd></div>
          <div><dt>現在開いているファイル</dt><dd>{summary ? `${summary.currentFiles.toLocaleString('ja-JP')} 件` : info?.error ? '確認できません' : '確認中…'}</dd></div>
          <div><dt>設定情報</dt><dd>現在は保存していません</dd></div>
        </dl>
        <div className="storage-actions">
          <Button variant="secondary" isDestructive disabled={!summary?.currentFiles} onClick={() => askDelete('current')}>現在開いているファイルを削除</Button>
          <Button variant="secondary" isDestructive disabled={!summary || !(summary.files - summary.currentFiles || summary.changes - summary.currentChanges)} onClick={() => askDelete('other')}>ほかの保存済みファイルを削除</Button>
          <Button variant="secondary" isDestructive disabled={!summary?.changes} onClick={() => askDelete('drafts')}>下書きだけを削除</Button>
        <Button variant="secondary" isDestructive disabled={!canClear}
            onClick={() => askDelete('all')}>一時保存をすべて削除</Button>
        </div>
      </section>
    </dialog>
    <dialog ref={confirmDialog} aria-labelledby="clear-drafts-title" onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <h2 id="clear-drafts-title">{categories[scope].title}</h2>
      <p>{categories[scope].description}</p>
      <p>書き出した PO ファイルはそのまま残ります。</p>
      {deleteError && <p role="alert">削除できませんでした。もう一度お試しください。</p>}
      {busy && <p role="status">削除しています…</p>}
      <form method="dialog" className="draft-dialog-actions">
        <Button variant="secondary" type="submit" disabled={busy} autoFocus>キャンセル</Button>
        <Button variant="primary" isDestructive type="button" disabled={busy} onClick={deleteData}>
          {scope === 'other' ? '削除する' : '削除して変更を取り消す'}
        </Button>
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
