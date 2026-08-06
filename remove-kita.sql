-- ============================================================
-- remove-kita.sql — 删除官方陪聊 Kita 及其全部关联数据(含 AI 公司股票)
--
-- 用法(Linux 服务器, 需 sqlite3 命令行):
--   建议先备份:  cp data/microx.db data/microx.db.bak
--   sqlite3 data/microx.db < remove-kita.sql
--
-- 注: 本库未开启外键级联(PRAGMA foreign_keys=OFF), 因此按依赖顺序显式删除。
-- ============================================================
BEGIN;

-- 1. Kita 的 AI 公司股票(created_by=Kita 且 is_ai=1)及其行情/成交/持仓
DELETE FROM stock_trades   WHERE stock_id IN (SELECT id FROM stocks WHERE created_by=(SELECT id FROM users WHERE username='Kita') AND is_ai=1);
DELETE FROM stock_ticks    WHERE stock_id IN (SELECT id FROM stocks WHERE created_by=(SELECT id FROM users WHERE username='Kita') AND is_ai=1);
DELETE FROM stock_holdings WHERE stock_id IN (SELECT id FROM stocks WHERE created_by=(SELECT id FROM users WHERE username='Kita') AND is_ai=1);
DELETE FROM stocks         WHERE created_by=(SELECT id FROM users WHERE username='Kita') AND is_ai=1;

-- 2. 陪聊订阅 / 记忆 / Bot 行
DELETE FROM bot_subs      WHERE user_id=(SELECT id FROM users WHERE username='Kita') OR bot_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM bot_memories  WHERE user_id=(SELECT id FROM users WHERE username='Kita') OR bot_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM bots          WHERE user_id=(SELECT id FROM users WHERE username='Kita');

-- 3. Kita 的帖子及其互动
DELETE FROM tips     WHERE post_id IN (SELECT id FROM posts WHERE user_id=(SELECT id FROM users WHERE username='Kita'));
DELETE FROM likes    WHERE post_id IN (SELECT id FROM posts WHERE user_id=(SELECT id FROM users WHERE username='Kita'));
DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE user_id=(SELECT id FROM users WHERE username='Kita'));
DELETE FROM posts    WHERE user_id=(SELECT id FROM users WHERE username='Kita');

-- 4. Kita 的评论及其点赞
DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE user_id=(SELECT id FROM users WHERE username='Kita'));
DELETE FROM comment_likes WHERE user_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM likes         WHERE user_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM comments      WHERE user_id=(SELECT id FROM users WHERE username='Kita');

-- 5. 私信 / 转账 / 支付
DELETE FROM messages       WHERE sender_id=(SELECT id FROM users WHERE username='Kita') OR receiver_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM transfers      WHERE sender_id=(SELECT id FROM users WHERE username='Kita') OR receiver_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM payment_claims WHERE payment_id IN (SELECT id FROM payments WHERE sender_id=(SELECT id FROM users WHERE username='Kita'));
DELETE FROM payments       WHERE sender_id=(SELECT id FROM users WHERE username='Kita');

-- 6. 群相关
DELETE FROM group_members  WHERE user_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM group_reads    WHERE user_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM group_messages WHERE sender_id=(SELECT id FROM users WHERE username='Kita');

-- 7. 关注 / 通知 / 会话
DELETE FROM follows       WHERE follower_id=(SELECT id FROM users WHERE username='Kita') OR following_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM notifications WHERE user_id=(SELECT id FROM users WHERE username='Kita') OR actor_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM sessions      WHERE user_id=(SELECT id FROM users WHERE username='Kita');

-- 8. 商店/工单/举报
DELETE FROM user_items WHERE item_id IN (SELECT id FROM items WHERE seller_id=(SELECT id FROM users WHERE username='Kita'));
DELETE FROM items      WHERE seller_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM user_items WHERE user_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM tickets    WHERE user_id=(SELECT id FROM users WHERE username='Kita');
DELETE FROM reports    WHERE reporter_id=(SELECT id FROM users WHERE username='Kita')
                           OR (target_type IN ('user','shop') AND target_id=(SELECT id FROM users WHERE username='Kita'));

-- 9. 本人
DELETE FROM users WHERE username='Kita';

COMMIT;
