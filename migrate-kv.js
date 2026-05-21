#!/usr/bin/env bun
// KV 数据迁移脚本：把全局 key 迁到指定 userId 下
//
// 使用方式：
//   bun migrate-kv.js <userId>
//
// 例如：
//   bun migrate-kv.js user_3E1LApuUWCphB7ZUv3mBiK4OdHz
//
// 这个脚本通过 wrangler kv 命令行工具读写 KV，不调用 Cloudflare API
// 也不需要任何额外凭据

import { spawnSync } from 'node:child_process';

const NAMESPACE_BINDING = 'PORTFOLIO_KV';

const userId = process.argv[2];
if (!userId || !userId.startsWith('user_')) {
  console.error('用法: bun migrate-kv.js <userId>');
  console.error('  userId 必须以 user_ 开头');
  process.exit(1);
}

console.log(`目标 userId: ${userId}\n`);

// 读取旧的全局 key
const oldKeys = [
  { from: 'portfolio',     to: `portfolio:${userId}` },
  { from: 'system_prompt', to: `prompt:${userId}` },
];

for (const { from, to } of oldKeys) {
  console.log(`==> 读取 ${from}...`);
  const value = kvGet(from);
  if (value === null) {
    console.log(`    ${from} 不存在，跳过`);
    continue;
  }
  console.log(`    读到 ${value.length} 字节`);

  console.log(`==> 写入 ${to}...`);
  kvPut(to, value);
  console.log(`    写入完成`);

  console.log(`==> 删除旧 key ${from}...`);
  kvDelete(from);
  console.log(`    删除完成\n`);
}

console.log('迁移完成。');

function kvGet(key) {
  const r = spawnSync(
    'bun',
    ['x', 'wrangler', 'kv', 'key', 'get', key, `--binding=${NAMESPACE_BINDING}`, '--remote'],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    const err = (r.stderr || '') + (r.stdout || '');
    // wrangler 对不存在的 key 会返回 404 / "not found" / "Key not found"
    if (
      err.includes('404') ||
      err.toLowerCase().includes('not found') ||
      err.toLowerCase().includes('does not exist')
    ) {
      return null;
    }
    console.error(err);
    process.exit(1);
  }
  return r.stdout;
}

function kvPut(key, value) {
  // 通过 stdin 传值，避免命令行长度限制
  const r = spawnSync(
    'bun',
    ['x', 'wrangler', 'kv', 'key', 'put', key, value, `--binding=${NAMESPACE_BINDING}`, '--remote'],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
}

function kvDelete(key) {
  const r = spawnSync(
    'bun',
    ['x', 'wrangler', 'kv', 'key', 'delete', key, `--binding=${NAMESPACE_BINDING}`, '--remote'],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
}
