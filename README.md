# バド帖 / badcho

選手のバドミントン断片メモを蓄積し、けろ先生が地の文返しで応答するブラウザ完結ツール。
（Firebase Firestoreで端末をまたいだ同期に対応）

## 構成

- `index.html` / `app.js` / `style.css` — フロントエンド一式（ビルド不要・静的配信）
- `firestore.rules` — Firestoreセキュリティルール
- バックエンド：Firebase Firestore（プロジェクト名：`badocho`）

## URLの種類

| 役割 | URL形式 | 権限 |
|---|---|---|
| 初回セットアップ | `index.html`（パラメータなし） | けろ先生用URLの発行のみ |
| けろ先生（けろ先生） | `index.html?t={48文字hex}` | 選手追加・全閲覧・地の文返し・お題出題 |
| 選手 | `index.html?s={32文字hex}` | 自分の投稿のみ閲覧・追加・お題への回答 |

## けろ先生 ⇄ 選手のやりとり

- **地の文返し**：投稿（断片）に、けろ先生が情景・観察・例えで返す（採点・指示ではない）
- **お題を渡す**：けろ先生が選手に問いを手渡す。選手ホームにそっと届き、断片で答えられる（書かない選択も残す）
- **届いた印**：新しい地の文返しが届くと、選手ホームの投稿カードに印が出る
- **受け取りのしるべ**：選手が返しを開くと、けろ先生の詳細画面に「受け取りました」が静かに灯る（既読＝受領であって評価ではない）
- **いま読んでいる**：けろ先生が詳細を開いている間、選手側に「いま読んでいる最中です」が灯る（presence）
- **楽屋**：けろ先生だけの、選手に見えない独白メモ

## セットアップ手順

### 1. Firestoreルールの適用（初回1回のみ）

1. https://console.firebase.google.com/project/badocho/firestore/rules を開く
2. 表示されているルールを `firestore.rules` の内容で全置換
3. 「公開」をクリック

### 2. ローカルでの動作確認

```bash
cd badcho
python3 -m http.server 8000
# http://localhost:8000/ で開いて、初回セットアップ → けろ先生用URLを発行
```

### 3. GitHub Pagesへの公開

1. GitHubに**プライベート**リポジトリを作成
2. `badcho/` 配下を push
3. Settings → Pages → Source: `main` ブランチ → 保存
4. 数分後、`https://{user}.github.io/{repo}/` で公開される

### スマホ表示デモ（iPhoneサイズで全画面を確認）

```bash
cd badocho && python3 -m http.server 8799   # サーバ起動
node tools/phone-demo.cjs                    # 別タブで実行
# → badocho/demo/ に iPhone サイズの画面キャプチャが出力される
```

けろ先生⇄選手の往復（お題・届いた印・受け取り）をひと通り自動で動かし、
スマホでの見え方を撮影します（デモ用の「デモ太郎」は実行後に自動削除）。

## データ構造（Firestore）

```
/teacher_index/{teacherToken}
  └ { students: [{ name, token, addedAt }] }

/students/{studentToken}/posts/{postId}
  └ { date, createdAt, categories[], body, photoData,
      responses[{ id, from:'teacher'|'student', body, createdAt }],
      studentReadAt,      // 選手が地の文返しを受け取った時刻（受け取りのしるべ）
      fromPromptId,       // お題に答えた投稿のとき、元のお題id
      coachActiveSince }  // けろ先生のpresence（「いま読んでいる」）

/students/{studentToken}/prompts/{promptId}    // お題（けろ先生→選手）
  └ { body, status:'open'|'answered', createdAt, answeredPostId, answeredAt }

/coach_drafts/{teacherToken}/responses/{postId}  // 地の文返しの下書き（端末跨ぎ）
/coach_journal/{teacherToken}/entries/{entryId}  // 楽屋（けろ先生の独白）
```

> お題・既読は `/students/{studentToken}/**` のルールにそのまま収まるため、
> Firestoreルールの変更は不要。

## セキュリティ設計

- **認証なし、URLトークンのみ**のシンプル設計
- セキュリティ強度はトークンの推測難度（teacher: 192bit, student: 128bit のランダム）
- `apiKey` は公開されるが、これはFirebaseの仕様で正常
- Firestoreルールで**短いトークンの拒否**を強制

## 既知の制限

- 写真は端末内でリサイズ後、base64でFirestore文書に直接埋め込み（Storage未使用）。
  大きな写真だと1MB/文書の上限に近づくため、将来的にはFirebase Storage化が望ましい
- 選手URLを公開・流出すると、その選手の投稿は誰でも閲覧可能
- 選手が自分のURLを失うと、別の選手としてやり直しになる
