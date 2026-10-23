import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction } from "./production-types";
import { changeProductionContent } from "./production-content";
function fixture() {
  const s = emptyProduction();
  s.story.scenes = [1,2,3].map(sceneNumber => ({ sceneNumber, title: "Scene", location:"Room", timeOfDay:"Day", action:"Walk", dialogue:"", characters:["Pip"] }));
  s.characters = [{ id:"c",name:"Pip",description:"Toy",seed:1,locked:true,status:"LOCKED",options:[],referenceSheet:[] }];
  s.wardrobes = [{id:"w",characterId:"c",name:"Vest",prompt:"Blue vest",fromScene:2,toScene:3,status:"READY"}];
  s.places = [{id:"p",name:"Room",prompt:"Room",seed:1,status:"READY",variants:[]}];
  s.settings.sceneReferences = {"2":{placeId:"p"}};
  return s;
}
test("scene removal renumbers assignments and wardrobe ranges without mutating source",()=>{
  const s=fixture(), n=changeProductionContent(s,{kind:"scene",id:"1",remove:true});
  assert.equal(n.story.scenes.length,2); assert.equal(s.story.scenes.length,3);
  assert.equal(n.wardrobes[0].fromScene,1);assert.equal(n.wardrobes[0].toScene,2);
  assert.equal(n.settings.sceneReferences?.["1"]?.placeId,"p");
});
test("character rename updates cast; removal clears cast and outfits",()=>{
  const n=changeProductionContent(fixture(),{kind:"character",id:"c",fields:{name:"New Pip",description:"Toy"}});
  assert.deepEqual(n.story.scenes[0].characters,["New Pip"]);
  const removed=changeProductionContent(n,{kind:"character",id:"c",remove:true});
  assert.equal(removed.wardrobes.length,0); assert.equal(removed.story.scenes[0].characters.length,0);
});
test("place and wardrobe removal clear only their project records",()=>{
  const n=changeProductionContent(fixture(),{kind:"place",id:"p",remove:true});
  assert.equal(n.settings.sceneReferences?.["2"],null);
  assert.equal(changeProductionContent(n,{kind:"wardrobe",id:"w",remove:true}).wardrobes.length,0);
});
test("active jobs and invalid wardrobe ranges are rejected",()=>{
  const s=fixture();s.tasks=[{id:"t",type:"story",status:"RUNNING",index:0}];
  assert.throws(()=>changeProductionContent(s,{kind:"scene",id:"1",remove:true}),/generation/);
  assert.throws(()=>changeProductionContent(fixture(),{kind:"wardrobe",id:"w",fields:{name:"Vest",prompt:"Blue",fromScene:3,toScene:1}}),/Last scene/);
});
