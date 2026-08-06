-- ============================================================
-- delete-user.sql — 删除任意用户及其全部关联数据
--
-- 用法:
--   1) 把下面两个 'CHANGE_ME' 中的 USERNAME 替换为目标用户名
--      (Windows 记事本/VSCode 直接改后保存)
--   2) 先备份:  cp data/microx.db data/microx.db.bak
--   3) 执行:    sqlite3 data/microx.db < delete-user.sql
--
-- 注: 本库未开启外键级联, 故按依赖顺序显式删除。
--     该用户创建的 AI 陪聊机器人、股票、商店商品也会一并删除。
-- ============================================================
BEGIN;

-- ========== 该用户创建的 AI 陪聊机器人 ==========
-- 机器人自己的 AI 公司股票(created_by=机器人, is_ai=1)
DELETE FROM stock_trades   WHERE stock_id IN (SELECT id FROM stocks WHERE created_by IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM stock_ticks    WHERE stock_id IN (SELECT id FROM stocks WHERE created_by IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM stock_holdings WHERE stock_id IN (SELECT id FROM stocks WHERE created_by IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM stocks         WHERE created_by IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) AND is_ai=1;
-- 机器人的订阅/记忆
DELETE FROM bot_subs      WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR bot_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM bot_memories  WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR bot_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
-- 机器人发出的内容/私信等
DELETE FROM tips           WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM likes          WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM comments       WHERE post_id IN (SELECT id FROM posts WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM posts          WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM comment_likes  WHERE comment_id IN (SELECT id FROM comments WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM comment_likes  WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM likes          WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM comments       WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM messages       WHERE sender_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR receiver_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM transfers      WHERE sender_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR receiver_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM payment_claims WHERE payment_id IN (SELECT id FROM payments WHERE sender_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')));
DELETE FROM payments       WHERE sender_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM group_messages WHERE sender_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM group_members  WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM follows        WHERE follower_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR following_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM notifications  WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR actor_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM sessions       WHERE user_id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM bots           WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM users          WHERE id IN (SELECT user_id FROM bots WHERE creator_id=(SELECT id FROM users WHERE username='CHANGE_ME')) OR username='CHANGE_ME';

-- ========== 该用户自己创建的公司股票(非 AI) ==========
DELETE FROM stock_trades   WHERE stock_id IN (SELECT id FROM stocks WHERE created_by=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM stock_ticks    WHERE stock_id IN (SELECT id FROM stocks WHERE created_by=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM stock_holdings WHERE stock_id IN (SELECT id FROM stocks WHERE created_by=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM stocks         WHERE created_by=(SELECT id FROM users WHERE username='CHANGE_ME');

-- ========== 该用户直接产生的内容 ==========
DELETE FROM tips           WHERE post_id IN (SELECT id FROM posts WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM likes          WHERE post_id IN (SELECT id FROM posts WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM comments       WHERE post_id IN (SELECT id FROM posts WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM posts          WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM comment_likes  WHERE comment_id IN (SELECT id FROM comments WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM comment_likes  WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM likes          WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM comments       WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');

-- 私信 / 转账 / 支付
DELETE FROM messages       WHERE sender_id=(SELECT id FROM users WHERE username='CHANGE_ME') OR receiver_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM transfers      WHERE sender_id=(SELECT id FROM users WHERE username='CHANGE_ME') OR receiver_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM payment_claims WHERE payment_id IN (SELECT id FROM payments WHERE sender_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM payments       WHERE sender_id=(SELECT id FROM users WHERE username='CHANGE_ME');

-- 群相关
DELETE FROM group_members  WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM group_reads    WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM group_messages WHERE sender_id=(SELECT id FROM users WHERE username='CHANGE_ME');

-- 关注 / 通知 / 会话
DELETE FROM follows       WHERE follower_id=(SELECT id FROM users WHERE username='CHANGE_ME') OR following_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM notifications WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME') OR actor_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM sessions      WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');

-- 商店 / 工单 / 举报
DELETE FROM user_items WHERE item_id IN (SELECT id FROM items WHERE seller_id=(SELECT id FROM users WHERE username='CHANGE_ME'));
DELETE FROM items      WHERE seller_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM user_items WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM tickets    WHERE user_id=(SELECT id FROM users WHERE username='CHANGE_ME');
DELETE FROM reports    WHERE reporter_id=(SELECT id FROM users WHERE username='CHANGE_ME')
                           OR (target_type IN ('user','shop') AND target_id=(SELECT id FROM users WHERE username='CHANGE_ME'));

-- ========== 本人 ==========
DELETE FROM users WHERE username='CHANGE_ME';

COMMIT;
