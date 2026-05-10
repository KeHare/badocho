# バド帖 / badcho

教え子のバドミントン断片メモを蓄積し、渡部さんが地の文返しで応答するブラウザ完結ツール。
（Firebase Firestoreで端末をまたいだ同期に対応）

## 構成

- `index.html` / `app.js` / `style.css` — フロントエンド一式（ビルド不要・静的配信）
- `firestore.rules` — Firestoreセキュリティルール
- バックエンド：Firebase Firestore（プロジェクト名：`badocho`）

## URLの種類

| 役割 | URL形式 | 権限 |
|---|---|---|
| 初回セットアップ | `index.html`（パラメータなし） | 渡部さん用URLの発行のみ |
| 渡部さん（教師） | `index.html?t={48文字hex}` | 教え子追加・全閲覧・地の文返し |
| 教え子 | `index.html?s={32文字hex}` | 自分の投稿のみ閲覧・追加 |

## セットアップ手順

### 1. Firestoreルールの適用（初回1回のみ）

1. https://console.firebase.google.com/project/badocho/firestore/rules を開く
2. 表示されているルールを `firestore.rules` の内容で全置換
3. 「公開」をクリック

### 2. ローカルでの動作確認

```bash
cd badcho
python3 -m http.server 8000
# http://localhost:8000/ で開いて、初回セットアップ → 渡部さん用URLを発行
```

### 3. GitHub Pagesへの公開

1. GitHubに**プライベート**リポジトリを作成
2. `badcho/` 配下を push
3. Settings → Pages → Source: `main` ブランチ → 保存
4. 数分後、`https://{user}.github.io/{repo}/` で公開される

## データ構造（Firestore）

```
/teacher_index/{teacherToken}
  └ { students: [{ name, token, addedAt }] }

/students/{studentToken}/posts/{postId}
  └ { date, createdAt, categories[], body, photoUrl, responses[] }
```

## セキュリティ設計

- **認証なし、URLトークンのみ**のシンプル設計
- セキュリティ強度はトークンの推測難度（teacher: 192bit, student: 128bit のランダム）
- `apiKey` は公開されるが、これはFirebaseの仕様で正常
- Firestoreルールで**短いトークンの拒否**を強制

## 既知の制限

- 写真投稿はURL指定のみ（Firebase Storage未使用）
- 教え子URLを公開・流出すると、その教え子の投稿は誰でも閲覧可能
- 教え子が自分のURLを失うと、別の教え子としてやり直しになる
