# 栽培記録アプリ HANDOFF

## 経緯・方針（2026-08-03 決定）

元仕様: Googleドライブ「栽培記録アプリ_仕様概要.md」（React+Vite+Supabase+Claude API案）。
コストゼロ条件と矛盾するため以下に変更して原さん承認済み:

- **Supabase → 使わない**（無料枠の自動一時停止・1GB制限を回避）
- **Claude API → 使わない**。AI機能（週次まとめ・振り返り・収穫写真推定）は Claude Code が
  Drive/Sheets MCP経由で担当する（追加費用ゼロ）
- **React+Vite → バニラJS**（このPCにNode.jsが無い。ビルド不要で十分）
- ホスティング: GitHub Pages（haradsan アカウント、公開リポジトリ）
- 同期: フェーズ2で GAS Webアプリ → Googleスプレッドシート+Drive

## フェーズ計画

1. ✅ PWA本体（入力・閲覧・マスタ管理・JSONバックアップ）← 今ここ
2. GAS同期（シート+Drive。競合解決は「新しい方を採用」）
3. Claude Code連携（週次まとめスキル+スケジュールタスク）
4. 収穫較正・画像推定（データが貯まってから）
5. 分析グラフ（横軸=播種からの経過日数）

## 実装メモ

- IndexedDB `saibai-log` v1。ストア: seasons / crops / varieties / locations / plantings /
  records(idx: plantingId, recordedAt) / photos(idx: recordId) / settings
- 全レコード `updatedAt` ISO文字列を持つ（将来の同期・マージ用）
- 写真は canvas で長辺1280px/JPEG80%に圧縮して Blob 保存
- バックアップ: 設定画面からJSON書き出し（写真はbase64内包）/ 読み込み（新しい方を採用でマージ）
- 初期マスタ: トマト(株別ON)+ピンキー、エンサイ、モロヘイヤ / engawa・ガレージ・2階
- 記録種別: 観察/作業/収穫/失敗/施肥/環境。収穫のみ重量g・果数のプリセットボタン入力
- 収穫累計は栽培単位詳細に表示。「播種から◯日」を各所に表示
- SW はネットワーク優先+キャッシュフォールバック（更新が届きやすく、オフラインでも動く）

## 未着手・保留

- supports / lowering_events / reference_objects / calibrations / harvest_estimates テーブルは
  フェーズ4まで作らない（元仕様から意図的に削減）
- 入力時のリアルタイムAI仕分けは不採用（最近使った順チップ+3タップ入力で代替）
- 分析画面はフェーズ5

## デプロイ

```
git push origin main
```

GitHub Pages が main ブランチ直下を自動配信。URL: https://haradsan.github.io/saibai-log/
