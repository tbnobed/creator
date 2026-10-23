import test from "node:test";
import assert from "node:assert/strict";
import {emptyProduction} from "./production-types";
import {openingInputs,requireOpening} from "./production-openings";
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
