import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction, type ProductionCharacter } from "./production-types";
import { productionAppearance, approvedProductionProp } from "./production-appearance";
const character: ProductionCharacter = {id:"c",name:"Pip",description:"Toy",seed:1,selectedAssetId:"bare",locked:true,options:[],referenceSheet:[],status:"LOCKED"};
test("prop replacement cannot reuse an older image's approval",()=>{
  const state=emptyProduction();
  assert.equal(approvedProductionProp(state),undefined);
  state.propReference={assetId:"ball",mediaUrl:"/test.png",description:"small red ball"};
  assert.throws(()=>approvedProductionProp(state),/approve/);
  state.propReference.approvedAssetId="ball";
  assert.equal(approvedProductionProp(state)?.assetId,"ball");
  state.propReference.assetId="replacement";
  assert.throws(()=>approvedProductionProp(state),/approve/);
});
test("only the approved dressed portrait conditions wardrobe scenes",()=>{
  const state=emptyProduction();
  state.wardrobes=[{id:"w",characterId:"c",name:"Vest",prompt:"Blue vest",fromScene:1,toScene:2,status:"READY",assetId:"dressed",approvedAssetId:"dressed"}];
  assert.equal(productionAppearance(state,character,1).assetId,"dressed");
  assert.equal(productionAppearance(state,character,2).assetId,"dressed");
  assert.equal(productionAppearance(state,character,3).assetId,"bare");
  state.wardrobes[0].approvedAssetId=undefined;
  assert.throws(()=>productionAppearance(state,character,1),/approve/);
});
test("newer unapproved candidates cannot fall back silently to old approval",()=>{
  const state=emptyProduction();
  state.wardrobes=[{id:"a",characterId:"c",name:"old",prompt:"blue",fromScene:1,toScene:2,status:"READY",assetId:"a",approvedAssetId:"a"},
    {id:"b",characterId:"c",name:"new",prompt:"blue",fromScene:1,toScene:2,status:"READY",assetId:"b"}];
  assert.throws(()=>productionAppearance(state,character,1),/approve/);
  assert.throws(()=>productionAppearance(state,{...character,locked:false},3),/Lock/);
});
