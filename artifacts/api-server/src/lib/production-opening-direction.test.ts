import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction } from "./production-types";
import { reviewOpeningDirection } from "./production-opening-direction";
import { openingInputs, openingGenerationInputs } from "./production-openings";
import { queueOpeningCandidates } from "./production-opening-history";

function fixture() {
  const state = emptyProduction();
  const names = ["Subject A", "Subject B"];
  state.characters = names.map(name => ({ id:name,name,description:"Unapproved appearance prose",
    selectedAssetId:`${name}-image`,locked:true,status:"LOCKED",seed:1,options:[],referenceSheet:[] }));
  state.places = [{id:"set",name:"Set",prompt:"Set",seed:1,status:"READY",assetId:"set-image",variants:[]}];
  const scene = {sceneNumber:1,title:"Scene",location:"Set",timeOfDay:"Day",characters:names,
    action:"Original story action",dialogue:"",shots:[{prompt:"Unreviewed shot direction",dialogue:"Keep this dialogue",durationSeconds:8}],
    opening:{assetId:"old",approvedAssetId:"old",sourceKey:"old",status:"READY"}};
  state.story.scenes=[scene];
  return {state,scene};
}
test("reviewed direction replaces old prompt in the production builder and queued source",()=>{
  const {state,scene}=fixture();
  const previous=openingInputs(state,scene);
  const direction="Subject A and Subject B wait beside the entrance.";
  reviewOpeningDirection(state,scene,{expectedDirection:scene.shots[0].prompt,direction});
  const inputs=openingInputs(state,scene);
  assert.ok(inputs.prompt.includes(direction));
  assert.ok(!inputs.prompt.includes("Unreviewed shot direction"));
  assert.ok(!inputs.prompt.includes("Unapproved appearance prose"));
  assert.notEqual(inputs.sourceKey,previous.sourceKey);
  assert.deepEqual(inputs.ids,previous.ids);
  assert.equal(scene.shots[0].dialogue,"Keep this dialogue");
  assert.equal(scene.action,"Original story action");
  assert.equal(scene.opening.status,"STALE");
  assert.equal(scene.opening.approvedAssetId,undefined);
  queueOpeningCandidates(state,scene,inputs.sourceKey);
  assert.equal(state.story.scenes[0].openingHistory?.at(-1)?.sourceKey,inputs.sourceKey);
  for(const subject of inputs.composition!.subjects) assert.ok(!subject.prompt.includes("Unreviewed shot direction"));
});
test("missing review, stale edits and empty direction cannot be submitted",()=>{
  const {state,scene}=fixture();
  assert.throws(()=>reviewOpeningDirection(state,scene,{}),/Review/);
  assert.throws(()=>reviewOpeningDirection(state,scene,{expectedDirection:"older",direction:"new"}),/Review/);
  assert.throws(()=>reviewOpeningDirection(state,scene,{expectedDirection:scene.shots[0].prompt,direction:" "}),/Opening direction/);
});
test("active same-scene work blocks changed direction but allows reviewed alternatives",()=>{
  const {state,scene}=fixture();
  queueOpeningCandidates(state,scene,"source");
  const current=scene.shots[0].prompt;
  assert.throws(()=>reviewOpeningDirection(state,scene,{expectedDirection:current,direction:"changed"}),/queued openings/);
  assert.doesNotThrow(()=>reviewOpeningDirection(state,scene,{expectedDirection:current,direction:current}));
});
test("single-subject corrections use approved originals and the reviewed replacement action",()=>{
  const {state,scene}=fixture();
  scene.characters=scene.characters.slice(0,1);
  state.characters=state.characters.slice(0,1);
  reviewOpeningDirection(state,scene,{expectedDirection:scene.shots[0].prompt,direction:"Subject A waits beside the entrance."});
  const inputs=openingGenerationInputs(state,scene,"Adjust the framing.");
  assert.ok(inputs.prompt.includes(scene.shots[0].prompt));
  assert.ok(inputs.prompt.includes("Adjust the framing."));
  assert.ok(!inputs.ids.includes("old"));
  assert.deepEqual(inputs.ids,["set-image","Subject A-image"]);
  assert.equal(inputs.sourceKey,openingInputs(state,scene).sourceKey);
});
