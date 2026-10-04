import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('@socialplay/config',()=>({config:{STORAGE_LOCAL_PATH:''}}));
import {config} from '@socialplay/config';
import {storageRoutes} from './storage.js';
let root:string;
let server:ReturnType<typeof Fastify>;
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'storage-privacy-'));
  config.STORAGE_LOCAL_PATH=root;
  for(const bucket of ['voice-messages','avatars']){
    await mkdir(join(root,bucket));
    await writeFile(join(root,bucket,'fixture.ogg'),'private-audio-fixture');
  }
  server=Fastify();await server.register(storageRoutes,{prefix:'/storage'});
});
afterEach(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
it.each([{}, {authorization:'Bearer an-untrusted-token'}])('never serves a voice file through the public storage route (%j)',async headers=>{
  const response=await server.inject({url:'/storage/voice-messages/fixture.ogg',headers});
  expect(response.statusCode).toBe(404);
  expect(response.body).not.toContain('private-audio-fixture');
  const missing=await server.inject({url:'/storage/voice-messages/missing.ogg',headers});
  expect(missing.statusCode).toBe(response.statusCode);
  expect(missing.body).toBe(response.body);
});
it('retains the existing public avatar route',async()=>{
  const response=await server.inject({url:'/storage/avatars/fixture.ogg'});
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe('private-audio-fixture');
});
