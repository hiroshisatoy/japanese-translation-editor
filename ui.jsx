import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, SearchControl, Modal } from '@wordpress/components';
import { Field, Fieldset, Radio, RadioGroup, Stack, useEnableWpCompatOverlaySlot } from '@wordpress/ui';
import '@wordpress/components/build-style/style.css';
import '@wordpress/theme/design-tokens.css';

// Mount controls before app.js binds the catalog and virtual-list handlers.
function mount(id, content) {
  flushSync(() => createRoot(document.getElementById(id)).render(content));
}

function Search() {
  const [value, setValue] = useState('');
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
function DraftStatus() {
  useEnableWpCompatOverlaySlot();
  const [status, setStatus] = useState({state: 'loading', message: '一時保存を確認しています', canClear: false});
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const update = (event) => setStatus(event.detail);
    document.addEventListener('translation-draft-status', update);
    return () => document.removeEventListener('translation-draft-status', update);
  }, []);
  return <div className="draft-bar">
    <p id="draft-status" role="status" data-state={status.state}>{status.message}</p>
    <Button variant="tertiary" size="small" disabled={!status.canClear}
      onClick={() => setConfirm(true)}>一時保存をすべて削除</Button>
    {confirm && <Modal title="一時保存をすべて削除" onRequestClose={() => setConfirm(false)}>
      <p>このブラウザーに保存したファイルと下書きを削除し、開いているファイルの変更を取り消します。</p>
      <p>次に編集すると自動保存を再開します。書き出した PO ファイルはそのまま残ります。</p>
      <div className="draft-dialog-actions">
        <Button variant="secondary" onClick={() => setConfirm(false)}>キャンセル</Button>
        <Button variant="primary" isDestructive onClick={() => {
          document.dispatchEvent(new Event('translation-clear-drafts'));
          setConfirm(false);
        }}>削除して変更を取り消す</Button>
      </div>
    </Modal>}
  </div>;
}
mount('wp-actions', <>
  <Button id="export" variant="secondary" disabled __next40pxDefaultSize>変更を書き出す</Button>
  <Button variant="primary" __next40pxDefaultSize onClick={() => document.getElementById('file').click()}>PO を開く</Button>
</>);
mount('wp-search', <Search />);
mount('wp-submit', <Button type="submit" variant="secondary" __next40pxDefaultSize>検索</Button>);
mount('wp-filters', <Filters />);
mount('wp-help', <Help />);
mount('wp-sample', <div className="empty-actions">
  <Button variant="primary" __next40pxDefaultSize onClick={() => document.getElementById('file').click()}>PO ファイルを開く</Button>
  <Button id="sample" variant="secondary" __next40pxDefaultSize>見本を表示</Button>
</div>);
mount('wp-drafts', <DraftStatus />);
