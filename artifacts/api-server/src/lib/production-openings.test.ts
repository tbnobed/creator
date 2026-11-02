import test from "node:test";
import assert from "node:assert/strict";
import {emptyProduction} from "./production-types";
import {openingCorrectionPrompt,openingInputs,requireOpening} from "./production-openings";
import {applyProductionPatch} from "./production-store";
function fixture(){
  const s=emptyProduction();
  s.story.scenes=[{sceneNumber:1,title:"Room",location:"Room",timeOfDay:"Day",characters:[],action:"A ball rolls",dialogue:""}];
  s.places=[{id:"p",name:"Room",prompt:"Sunny room",seed:1,status:"READY",assetId:"location",variants:[]}];
  return s;
}
test("opening approval is required and becomes stale when composition inputs change",()=>{
  const s=fixture(),scene=s.story.scenes[0];
  assert.throws(()=>requireOpening(s,scene),/approve/);
  scene.opening={sourceKey:openingInputs(s,scene).sourceKey,status:"READY",assetId:"frame"};
  assert.throws(()=>requireOpening(s,scene),/approve/);
  scene.opening.approvedAssetId="frame";
  assert.equal(requireOpening(s,scene).assetId,"frame");
  s.settings.width=1920;
  assert.throws(()=>requireOpening(s,scene),/approve/);
});
test("draft saves retain only server-owned opening approval, never client-forged approval",()=>{
  const s=fixture(),scene=s.story.scenes[0];
  scene.opening={sourceKey:openingInputs(s,scene).sourceKey,status:"READY",assetId:"frame",approvedAssetId:"frame"};
  const saved=applyProductionPatch(s,{story:{scenes:[{...scene,opening:{assetId:"forged",approvedAssetId:"forged"}}]}});
  assert.equal(saved.story.scenes[0].opening?.assetId,"frame");
  const changed=applyProductionPatch(s,{story:{scenes:[{...scene,action:"Different action"}]}});
  assert.equal(changed.story.scenes[0].opening,undefined);
});

test("outdoor openings preserve marsh scenery without injecting an interior", () => {
  const s = fixture(), scene = s.story.scenes[0];
  scene.title = "EXT. UPPER NEWPORT BAY — DAWN";
  scene.location = "Cordgrass marsh";
  scene.action = "A gull flies over cordgrass and a winding tidal channel beneath an open sky.";
  s.places[0].name = scene.location;
  const inputs = openingInputs(s, scene);
  assert.match(inputs.prompt, /at the location shown in image 1/);
  assert.match(inputs.prompt, /environment, layout, scenery and lighting/);
  assert.ok(inputs.prompt.includes(scene.action));
  assert.doesNotMatch(inputs.prompt, /\b(room|inside|interior|ceiling|roof)\b/i);
  assert.doesNotMatch(inputs.prompt, /from images? \./);
  assert.deepEqual(inputs.ids, ["location"]);
});

test("indoor openings keep authored indoor direction, cast and reference numbering", () => {
  const s = fixture(), scene = s.story.scenes[0];
  scene.characters = ["Mara"];
  scene.action = "Inside the bakery room, Mara opens the oven beside the counter.";
  s.characters = [{
    id: "mara", name: "Mara", description: "Baker", seed: 1, options: [],
    selectedAssetId: "mara-image", locked: true, referenceSheet: [], status: "LOCKED",
  }];
  const inputs = openingInputs(s, scene);
  assert.ok(inputs.prompt.includes(scene.action));
  assert.match(inputs.prompt, /Exactly 1 character, each appearing ONCE, from image 2/);
  assert.deepEqual(inputs.ids, ["location", "mara-image"]);
  assert.doesNotMatch(inputs.prompt, /photograph inside the room/);
});

test("opening corrections stay location-neutral unless the creator specifies an interior", () => {
  const outside = "Keep the gull above the tidal channel at dawn.";
  assert.ok(openingCorrectionPrompt(outside).includes(outside));
  assert.match(openingCorrectionPrompt(outside), /props, location, scenery, lighting and camera/);
  assert.doesNotMatch(openingCorrectionPrompt(outside), /\b(room|inside|interior|ceiling|roof)\b/i);
  const inside = "Brighten the bakery room without changing the counter.";
  assert.ok(openingCorrectionPrompt(inside).includes(inside));
});
