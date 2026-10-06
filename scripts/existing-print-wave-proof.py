"""One-shot articulated ink proof; no model inference or new artwork.

Coordinates deliberately select the gray monkey in this approved test footage,
not a product default. Dense flow is measured on untouched source frames.
"""
import cv2
import numpy as np
import pathlib
import subprocess
import json
import math

ROOT = pathlib.Path("attached_assets/existing-print-wave-proof")
ROOT.mkdir(parents=True, exist_ok=True)
SOURCE = "attached_assets/shirt-replacement-kling-proof/shirt-replacement.mp4"
cap = cv2.VideoCapture(SOURCE)
fps = cap.get(cv2.CAP_PROP_FPS)
ok, first = cap.read()
assert ok
h, w = first.shape[:2]
# Bounded chest crop, away from the face/background.
x0, y0, cw, ch = 560, 480, 270, 215
base = first[y0:y0+ch, x0:x0+cw].copy()
g0 = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
yy, xx = np.mgrid[:ch, :cw].astype(np.float32)
poly = np.array([[705,617],[732,606],[750,591],[754,582],[767,578],
                 [775,592],[776,603],[768,615],[743,638],[721,648],[708,637]])
poly -= [x0,y0]
region = np.zeros((ch,cw),np.uint8)
cv2.fillPoly(region,[poly],255)
b,g,r = cv2.split(base.astype(np.float32))
# Select gray-blue ink; retain the white distressed gaps and nearby button.
ink = ((b-r>6)&(b-r<50)&(g-r<35)&(r>90)&(r<205)&(b<225)&(region>0)).astype(np.uint8)*255
ink = cv2.morphologyEx(ink,cv2.MORPH_CLOSE,np.ones((2,2),np.uint8))
alpha0 = cv2.GaussianBlur(ink.astype(np.float32)/255,(3,3),.65)
erase0 = cv2.dilate(region,np.ones((5,5),np.uint8))
# The shirt button is foreground cloth hardware, not part of the illustration.
button0 = np.zeros_like(ink)
cv2.circle(button0,(633-x0,581-y0),10,255,-1)
alpha0[button0>0]=0
erase0[button0>0]=0
clean0 = cv2.inpaint(base,erase0,5,cv2.INPAINT_TELEA)
paid_plate = ROOT/"fabric-clean.png"
if paid_plate.exists():
    # The generated image is used ONLY underneath the original arm mask.
    plate = cv2.resize(cv2.imread(str(paid_plate)),(270,270))
    clean0 = plate[30:245].copy()
    # Generated hardware must not replace the original seam/button pixels.
    hardware = (cv2.cvtColor(clean0,cv2.COLOR_BGR2GRAY)<185).astype(np.uint8)*255
    clean0 = cv2.inpaint(clean0,cv2.dilate(hardware,np.ones((3,3),np.uint8)),5,cv2.INPAINT_TELEA)
    # Match the generated patch's low-frequency color to nearby original cloth.
    # Never use ink pixels as lighting samples.
    known=(base.min(axis=2)>205)&((base.max(axis=2).astype(int)-base.min(axis=2))<22)&(erase0==0)
    delta=np.clip(base.astype(np.float32)-clean0.astype(np.float32),-70,70)
    correction=cv2.inpaint(np.uint8(delta+128),(~known).astype(np.uint8)*255,6,cv2.INPAINT_TELEA).astype(np.float32)-128
    correction=cv2.GaussianBlur(correction,(0,0),10)
    clean0=np.clip(clean0.astype(np.float32)+correction,0,255).astype(np.uint8)
shade0 = cv2.GaussianBlur(clean0.astype(np.float32),(0,0),9)
cv2.imwrite(str(ROOT/"selected-arm.png"),np.dstack([base,ink]))
cv2.imwrite(str(ROOT/"clean-patch.png"),clean0)
pivot = (711-x0,633-y0)
tracker = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
writer = cv2.VideoWriter(str(ROOT/"silent.mp4"),cv2.VideoWriter_fourcc(*"mp4v"),fps,(w,h))
assert writer.isOpened()
before_after = cv2.VideoWriter(str(ROOT/"comparison-silent.mp4"),cv2.VideoWriter_fourcc(*"mp4v"),fps,(cw*4,ch*2))
index=0
areas=[]
tip_displacement=[]
cap.set(cv2.CAP_PROP_POS_FRAMES,0)
while True:
    ok, frame = cap.read()
    if not ok: break
    roi = frame[y0:y0+ch,x0:x0+cw]
    gray = cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY)
    flow = tracker.calc(gray,g0,None) # current cloth -> original cloth
    mx,my = xx+flow[:,:,0], yy+flow[:,:,1]
    t=index/fps
    # Starts/ends at rest, lowers then raises the existing arm.
    angle = -18 * (.5-.5*math.cos(2*math.pi*.8*t)) * min(1,t/.3,max(0,(5-t)/.3))
    mat = cv2.getRotationMatrix2D(pivot,angle,1)
    a = cv2.warpAffine(alpha0,mat,(cw,ch))
    premul = cv2.warpAffine(base.astype(np.float32)*alpha0[:,:,None],mat,(cw,ch))
    a = cv2.remap(a,mx,my,cv2.INTER_LINEAR)
    colors = cv2.remap(premul,mx,my,cv2.INTER_LINEAR)/np.maximum(a[:,:,None],1e-5)
    old = cv2.remap(erase0,mx,my,cv2.INTER_NEAREST)
    if paid_plate.exists():
        clean = cv2.remap(clean0,mx,my,cv2.INTER_LINEAR)
        observed = cv2.GaussianBlur(roi.astype(np.float32),(0,0),15)
        original = cv2.remap(cv2.GaussianBlur(base.astype(np.float32),(0,0),15),mx,my,cv2.INTER_LINEAR)
        gain = np.clip(observed/np.maximum(original,40),.85,1.15)
        clean = np.clip(clean.astype(np.float32)*gain,0,255).astype(np.uint8)
    else:
        clean = cv2.inpaint(roi,old,5,cv2.INPAINT_TELEA)
    # Carry local lighting from the current cloth, rather than flat sprite light.
    light = cv2.GaussianBlur(clean.astype(np.float32),(0,0),9)
    ref_light = cv2.remap(shade0,mx,my,cv2.INTER_LINEAR)
    colors *= np.clip(light/np.maximum(ref_light,30),.75,1.25)
    # Preserve foreground skin. This clip test is not a general segmentation model.
    hsv=cv2.cvtColor(roi,cv2.COLOR_BGR2HSV)
    skin=((hsv[:,:,0]<25)&(hsv[:,:,1]>65)&(hsv[:,:,2]>70)).astype(np.uint8)
    skin=cv2.dilate(skin,np.ones((3,3),np.uint8))
    old[skin>0]=0
    a[skin>0]=0
    button=cv2.remap(button0,mx,my,cv2.INTER_NEAREST)>0
    a[button]=0
    old[button]=0
    seam=cv2.dilate((gray<90).astype(np.uint8),np.ones((3,3),np.uint8))>0
    a[seam]=0
    old[seam]=0
    erase_alpha=cv2.GaussianBlur(old.astype(np.float32)/255,(7,7),1.2)
    erase_alpha[(skin>0)|button|seam]=0
    out=roi.astype(np.float32)*(1-erase_alpha[:,:,None])+clean.astype(np.float32)*erase_alpha[:,:,None]
    out=np.clip(out.astype(np.float32)*(1-a[:,:,None])+colors*a[:,:,None],0,255).astype(np.uint8)
    support=(erase_alpha>.001)|(a>.001)
    out[~support]=roi[~support]
    frame_out=frame.copy()
    frame_out[y0:y0+ch,x0:x0+cw]=out
    outside=np.ones((h,w),bool)
    outside[y0:y0+ch,x0:x0+cw]=~support
    assert np.array_equal(frame_out[outside],frame[outside])
    writer.write(frame_out)
    compare=np.concatenate([roi,out],axis=1)
    compare=cv2.resize(compare,None,fx=2,fy=2)
    cv2.putText(compare,"SOURCE",(12,24),0,.65,(0,0,255),2)
    cv2.putText(compare,"EXISTING INK: ARM WAVE",(cw*2+12,24),0,.65,(0,0,255),2)
    before_after.write(compare)
    if index%12==0:cv2.imwrite(str(ROOT/f"check-{index:03}.jpg"),compare)
    areas.append(int(support.sum()))
    tip_displacement.append(abs(angle))
    index+=1
cap.release();writer.release();before_after.release()
for src,dst in [("silent.mp4","existing-monkey-wave.mp4"),("comparison-silent.mp4","comparison.mp4")]:
    subprocess.run(["ffmpeg","-v","error","-y","-i",str(ROOT/src),"-i",SOURCE,
                    "-map","0:v:0","-map","1:a:0","-c:v","libx264","-crf","16",
                    "-pix_fmt","yuv420p","-c:a","copy","-movflags","+faststart",str(ROOT/dst)],check=True)
    (ROOT/src).unlink()
(ROOT/"verification.json").write_text(json.dumps({"frames":index,"fps":fps,"originalPixelsOutsideMaskUnchanged":True,
    "maxEditedPixels":max(areas),"maxArmRotationDegrees":max(tip_displacement),
    "newArtworkGenerated":False,"usesPaidFabricPlate":paid_plate.exists(),
    "limitations":["local dense flow is approximate","skin-color occlusion mask is specific to this proof","restored fabric is estimated, not ground truth"]},indent=2))
print(ROOT/"existing-monkey-wave.mp4")
