import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertGarmentKey, buildGarmentGraph, checkGarmentRuntime, garmentFrames, garmentScript, prepareGarmentSource, renderGarmentPrint } from "./garment-media";
import { probeVideoMediaProperties } from "./video-media-probe";
import { execFileSync } from "node:child_process";
const tenant="00000000-0000-4000-8000-000000000001";
test("garment keys cannot cross tenants or escape storage",()=>{
  const key=`tenants/${tenant}/generation-references/00000000-0000-4000-8000-000000000002.mp4`;
  assert.doesNotThrow(()=>assertGarmentKey(key,tenant));
  assert.throws(()=>assertGarmentKey(key,"00000000-0000-4000-8000-000000000009"));
  assert.throws(()=>assertGarmentKey(key.replace("generation-references","../generation-references"),tenant));
  assert.throws(()=>assertGarmentKey(key,tenant,true));
});
test("proof duration allocation obeys VACE 4n+1 frames",()=>{
  for(const d of [.5,.7,1,2,3]) {
    const n=garmentFrames(d);assert.equal((n-1)%4,0);assert.ok(n>=d*16);assert.ok(n<=49);
  }
  for(const d of [NaN,Infinity,-1,0,.49,3.1]) assert.throws(()=>garmentFrames(d));
});
test("replacement and print graph outputs cannot be confused",async()=>{
  const base={filename:"source.mp4",prefix:"test",prompt:"Orange jacket",seed:42,frames:17,targetGarment:"jacket worn by the person on the left"};
  const replace=await buildGarmentGraph({...base,mode:"replace-garment",reference:"shirt.png"}) as Record<string,{inputs:Record<string,unknown>}>;
  assert.deepEqual(replace["16"].inputs.control_video,["26",0]);
  assert.deepEqual(replace["16"].inputs.reference_image,["23",0]);
  assert.equal(replace["16"].inputs.length,17);
  assert.equal(replace["4"].inputs.text,base.targetGarment);
  assert.deepEqual(replace["21"].inputs.audio,["2",1]);
  const print=await buildGarmentGraph({...base,mode:"animate-artwork",prompt:"Make the birds flap their wings"}) as typeof replace;
  assert.ok(print["9"]);assert.ok(print["10"]);assert.ok(print["22"]);
  assert.match(String(print["14"].inputs.text),/birds flap their wings/);
  assert.deepEqual(print["16"].inputs.reference_image,["27",0]);
  assert.equal(print["16"].inputs.length,17);
  assert.equal(print["4"].inputs.text,base.targetGarment);
  assert.match(String(print["14"].inputs.text),/jacket worn by the person on the left/);
  const uploaded=await buildGarmentGraph({...base,mode:"animate-artwork",reference:"birds.png"}) as typeof replace;
  assert.deepEqual(uploaded["16"].inputs.reference_image,["23",0]);
  assert.equal(uploaded["23"].inputs.image,"birds.png");
  assert.ok(!uploaded["27"]);
  await assert.rejects(buildGarmentGraph({...base,mode:"animate-artwork",prompt:" "}));
});
test("real source preparation and moving-print finalization preserve framing/audio",async()=>{
  await checkGarmentRuntime();
  const root=path.dirname(path.dirname(garmentScript("garment-proof.py")));
  const folder=path.join(root,"reports/garment-proof-2026-10-02");
  const source=await readFile(path.join(folder,"source.mp4"));
  const mask=await readFile(path.join(folder,"mask.mp4"));
  await assert.rejects(prepareGarmentSource(source,3,1),/inside/);
  const prepared=await prepareGarmentSource(source,0,3);
  assert.equal(prepared.frames,49);
  const normalized=await probeVideoMediaProperties(prepared.bytes);
  assert.equal(normalized.width,512);assert.equal(normalized.height,288);
  const output=await renderGarmentPrint(source,mask);
  const p=await probeVideoMediaProperties(output);
  assert.equal(p.width,512);assert.equal(p.height,288);
  assert.ok(Math.abs(p.durationSeconds-3.0625)<.03);
  assert.equal(p.audioStreams,1);
  const audioHash=(b:Buffer)=>execFileSync("ffmpeg",["-v","error","-i","pipe:0","-map","0:a:0","-c","copy","-f","hash","-hash","sha256","-"],{input:b}).toString();
  assert.equal(audioHash(source),audioHash(output));
  await assert.rejects(renderGarmentPrint(source,Buffer.from("not a video")));
});