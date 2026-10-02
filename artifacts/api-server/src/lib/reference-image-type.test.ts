import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import router from "../routes/generation-reference-media";
import { mediaStorage } from "./storage-service";
import { referenceImageType } from "./reference-image-type";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+AAAAABJRU5ErkJggg==","base64");
test("detects raster contents regardless of filename or MIME label",()=>{
  assert.equal(referenceImageType(png),"image/png");
  assert.equal(referenceImageType(Buffer.from([255,216,255,224])),"image/jpeg");
  assert.equal(referenceImageType(Buffer.from("RIFF1234WEBP")),"image/webp");
  for(const b of [Buffer.alloc(0),Buffer.from("<svg/>"),Buffer.from("not an image")]) assert.equal(referenceImageType(b),null);
});
test("real upload route normalizes a PNG mislabeled JPEG and rejects invalid bytes",async t=>{
  const captured: string[]=[];
  t.mock.method(mediaStorage,"storeGenerationReferenceMedia",async(mime:string)=>{
    captured.push(mime);return "tenants/11111111-1111-4111-8111-111111111111/generation-references/22222222-2222-4222-8222-222222222222.png";
  });
  const app=express();
  app.use((req,_res,next)=>{req.context={tenant:{id:"11111111-1111-4111-8111-111111111111"}} as typeof req.context;next();});
  app.use(router);
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/generations/reference-media`;
  try {
    const response=await fetch(url,{method:"POST",headers:{"Content-Type":"image/jpeg","X-File-Name":"garment.jpg"},body:png});
    assert.equal(response.status,201);
    assert.equal((await response.json() as {mimeType:string}).mimeType,"image/png");
    assert.deepEqual(captured,["image/png"]);
    const invalid=await fetch(url,{method:"POST",headers:{"Content-Type":"image/jpeg"},body:"not a jpeg"});
    assert.equal(invalid.status,400);
    assert.equal(captured.length,1);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});