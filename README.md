# RSS Grid

VS Code 内で RSS/Atom フィードを画像付きグリッドで読む拡張。

- ステータスバーの `RSS` か、コマンド `RSS Grid: 開く` で表示
- カテゴリタブ / キーワード絞り込み / ⟳で即更新 / 自動更新（既定15分、パネル表示中のみ）
- 画像: RSS内(media:thumbnail, enclosure, 本文img) → 無ければ記事ページの og:image
- カードクリックでブラウザで開く
- フィードは `＋` ボタンか settings.json の `rssGrid.feeds` で編集
