import React, { useRef, useEffect, useState } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, ArrowLeft, ArrowRight, 
  Trash2, RotateCcw, Save, Download, Video, LayoutGrid, 
  Settings2, Scissors, EyeOff, Clock 
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

export interface ClipMetadata {
  description?: string;
  duration?: number;
  [key: string]: any;
}

export interface Clip {
  id: string;
  outputUrl: string;
  metadata: ClipMetadata;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  isRemoved?: boolean;
}

export interface NLEEditorProps {
  projectTitle: string;
  clips: Clip[];
  selectedClipId: string | null;
  onSelectedClipIdChange: (id: string | null) => void;
  onChange: (clips: Clip[]) => void;
  onSave: () => void;
  isSaving?: boolean;
  onDownloadPackage?: () => void;
}

const formatTime = (seconds?: number) => {
  if (typeof seconds !== 'number' || isNaN(seconds)) return '00:00.0';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
};

export function NLEEditor({
  projectTitle,
  clips,
  selectedClipId,
  onSelectedClipIdChange,
  onChange,
  onSave,
  isSaving,
  onDownloadPackage
}: NLEEditorProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const selectedClipIndex = clips.findIndex(c => c.id === selectedClipId);
  const selectedClip = selectedClipIndex >= 0 ? clips[selectedClipIndex] : null;

  // When selected clip changes, reset video and play state
  useEffect(() => {
    if (videoRef.current) {
      const start = selectedClip?.trimStartSeconds || 0;
      videoRef.current.currentTime = start;
      setCurrentTime(start);
      setIsPlaying(false);
    }
  }, [selectedClip?.id]);

  // Video time update listener
  const handleTimeUpdate = () => {
    if (videoRef.current && selectedClip) {
      const current = videoRef.current.currentTime;
      setCurrentTime(current);
      
      const end = selectedClip.trimEndSeconds ?? selectedClip.metadata.duration ?? videoRef.current.duration;
      if (end && !isNaN(end) && current >= end) {
        videoRef.current.pause();
        setIsPlaying(false);
        videoRef.current.currentTime = selectedClip.trimStartSeconds || 0;
      }
    }
  };

  const handlePlayPause = () => {
    if (!videoRef.current || !selectedClip) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  // Reordering
  const moveClip = (index: number, direction: 'left' | 'right') => {
    if (direction === 'left' && index > 0) {
      const newClips = [...clips];
      [newClips[index - 1], newClips[index]] = [newClips[index], newClips[index - 1]];
      onChange(newClips);
    } else if (direction === 'right' && index < clips.length - 1) {
      const newClips = [...clips];
      [newClips[index], newClips[index + 1]] = [newClips[index + 1], newClips[index]];
      onChange(newClips);
    }
  };

  // Updating selected clip
  const updateSelectedClip = (updates: Partial<Clip>) => {
    if (selectedClipIndex === -1) return;
    const newClips = [...clips];
    newClips[selectedClipIndex] = { ...newClips[selectedClipIndex], ...updates };
    onChange(newClips);
  };

  const handleTrimStartChange = (val: number) => {
    const end = selectedClip?.trimEndSeconds ?? selectedClip?.metadata.duration ?? val + 0.1;
    const normalized = Math.max(0, Math.min(val, end - 0.1));
    updateSelectedClip({ trimStartSeconds: normalized });
    if (videoRef.current) {
      videoRef.current.currentTime = normalized;
      setCurrentTime(normalized);
    }
  };

  const handleTrimEndChange = (val: number) => {
    const start = selectedClip?.trimStartSeconds ?? 0;
    const duration = selectedClip?.metadata.duration ?? val;
    const normalized = Math.min(duration, Math.max(val, start + 0.1));
    updateSelectedClip({ trimEndSeconds: normalized });
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(start, normalized - 0.5);
      setCurrentTime(Math.max(start, normalized - 0.5));
    }
  };

  // Total project duration calculation (excluding removed clips)
  const totalDuration = clips
    .filter(c => !c.isRemoved)
    .reduce((acc, c) => {
      const start = c.trimStartSeconds || 0;
      const end = c.trimEndSeconds ?? c.metadata.duration ?? 0;
      return acc + Math.max(0, end - start);
    }, 0);

  const currentClipEnd = selectedClip?.trimEndSeconds ?? selectedClip?.metadata.duration ?? 0;

  return (
    <div className="flex flex-col h-full w-full bg-background text-foreground rounded-lg border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-card">
        <div className="flex items-center gap-3">
          <div className="bg-primary/20 p-2 rounded-md">
            <Video className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight leading-none mb-1">{projectTitle}</h2>
            <div className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              {formatTime(totalDuration)} Total Duration
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onDownloadPackage && (
            <Button variant="outline" size="sm" onClick={onDownloadPackage}>
              <Download className="w-4 h-4 mr-2" />
              Download NLE Package
            </Button>
          )}
          <Button variant="default" size="sm" onClick={onSave} disabled={isSaving}>
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? 'Saving...' : 'Save Timeline'}
          </Button>
        </div>
      </div>
      
      {/* Workspace Main */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden min-h-[400px]">
        {/* Video Player Area */}
        <div className="flex-1 flex flex-col bg-black/60 relative">
          <div className="flex-1 flex items-center justify-center p-4 md:p-8 relative">
            {selectedClip ? (
              <div className="relative w-full h-full flex items-center justify-center bg-black rounded-lg overflow-hidden border border-border/50 shadow-2xl">
                 <video 
                   ref={videoRef}
                   src={selectedClip.outputUrl}
                   className="w-full h-full object-contain"
                   onTimeUpdate={handleTimeUpdate}
                   onEnded={() => setIsPlaying(false)}
                   onClick={handlePlayPause}
                   playsInline
                 />
                 
                 {/* Play overlay if paused */}
                 {!isPlaying && (
                   <div 
                     className="absolute inset-0 flex items-center justify-center bg-black/10 cursor-pointer"
                     onClick={handlePlayPause}
                   >
                     <div className="bg-primary/90 text-primary-foreground rounded-full p-4 shadow-lg transform transition-transform hover:scale-110">
                       <Play className="w-8 h-8 ml-1" />
                     </div>
                   </div>
                 )}
                 
                 {/* Removed overlay */}
                 {selectedClip.isRemoved && (
                    <div className="absolute inset-0 flex items-center justify-center bg-destructive/20 backdrop-blur-sm pointer-events-none">
                      <div className="bg-destructive/90 text-white px-4 py-2 rounded-md font-bold tracking-widest uppercase flex items-center gap-2 shadow-2xl">
                        <EyeOff className="w-5 h-5" />
                        Clip Removed
                      </div>
                    </div>
                 )}
              </div>
            ) : (
              <div className="text-muted-foreground flex flex-col items-center">
                <Video className="w-12 h-12 mb-4 opacity-20" />
                <p>Select a clip from the timeline to preview</p>
              </div>
            )}
          </div>
          
          {/* Player Controls */}
          {selectedClip && (
            <div className="flex flex-col border-t border-border/30 bg-card/30 backdrop-blur">
               <div className="px-6 py-4">
                 <Slider 
                   value={[currentTime]} 
                   min={selectedClip.trimStartSeconds || 0} 
                   max={currentClipEnd || 100}
                   step={0.01}
                   onValueChange={([val]) => {
                     if (videoRef.current) {
                        videoRef.current.currentTime = val;
                        setCurrentTime(val);
                     }
                   }}
                   className="cursor-pointer"
                 />
               </div>
               <div className="px-6 pb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" className="hover:bg-primary/20" onClick={() => {
                       if (videoRef.current && selectedClip) {
                         videoRef.current.currentTime = selectedClip.trimStartSeconds || 0;
                       }
                    }}>
                      <SkipBack className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="hover:bg-primary/20" onClick={handlePlayPause}>
                      {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="hover:bg-primary/20" onClick={() => {
                       if (videoRef.current && selectedClip) {
                         videoRef.current.currentTime = currentClipEnd;
                       }
                    }}>
                      <SkipForward className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="font-mono text-sm text-muted-foreground bg-black/40 px-3 py-1 rounded">
                    <span className="text-foreground">{formatTime(currentTime)}</span> / {formatTime(currentClipEnd)}
                  </div>
               </div>
            </div>
          )}
        </div>
        
        {/* Inspector Panel */}
        <div className="w-full md:w-80 border-t md:border-t-0 md:border-l bg-card flex flex-col overflow-y-auto">
          <div className="p-4 border-b font-semibold flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Settings2 className="w-4 h-4" />
            Inspector
          </div>
          
          <div className="p-4 space-y-6">
            {!selectedClip ? (
               <p className="text-sm text-muted-foreground text-center py-8">No clip selected</p>
            ) : (
               <>
                 {/* Clip Info */}
                 <div className="space-y-2">
                    <h3 className="font-medium text-foreground leading-snug">
                      {selectedClip.metadata.description || 'Untitled Clip'}
                    </h3>
                    <p className="text-xs text-muted-foreground font-mono">ID: {selectedClip.id.substring(0,8)}...</p>
                 </div>
                 
                 {/* Trimming */}
                 <div className="space-y-4 pt-4 border-t">
                   <div className="flex items-center gap-2 text-sm font-medium">
                     <Scissors className="w-4 h-4 text-primary" />
                     Trim Controls
                   </div>
                   
                   <div className="grid grid-cols-2 gap-4">
                     <div className="space-y-1.5">
                       <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Start (s)</label>
                       <Input 
                         type="number" 
                         step="0.1"
                         min={0}
                         max={currentClipEnd - 0.1}
                         value={selectedClip.trimStartSeconds ?? ''}
                         onChange={(e) => {
                            const val = e.target.value;
                            if (val === '') handleTrimStartChange(0);
                            else handleTrimStartChange(parseFloat(val));
                         }}
                         className="font-mono text-sm"
                       />
                     </div>
                     <div className="space-y-1.5">
                       <label className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">End (s)</label>
                       <Input 
                         type="number" 
                         step="0.1"
                         min={(selectedClip.trimStartSeconds || 0) + 0.1}
                         max={selectedClip.metadata.duration}
                         value={selectedClip.trimEndSeconds ?? selectedClip.metadata.duration ?? ''}
                         onChange={(e) => {
                            const val = e.target.value;
                            if (val === '') {
                              updateSelectedClip({ trimEndSeconds: undefined });
                            } else {
                              handleTrimEndChange(parseFloat(val));
                            }
                         }}
                         className="font-mono text-sm"
                       />
                     </div>
                   </div>
                 </div>
                 
                 {/* Sequence Reorder */}
                 <div className="space-y-4 pt-4 border-t">
                   <div className="flex items-center gap-2 text-sm font-medium">
                     <LayoutGrid className="w-4 h-4 text-primary" />
                     Sequence Position
                   </div>
                   <div className="flex items-center gap-2">
                     <Button 
                       variant="outline" 
                       size="sm" 
                       className="flex-1 bg-transparent"
                       disabled={selectedClipIndex === 0}
                       onClick={() => moveClip(selectedClipIndex, 'left')}
                     >
                       <ArrowLeft className="w-4 h-4 mr-1" />
                       Move Left
                     </Button>
                     <Button 
                       variant="outline" 
                       size="sm" 
                       className="flex-1 bg-transparent"
                       disabled={selectedClipIndex === clips.length - 1}
                       onClick={() => moveClip(selectedClipIndex, 'right')}
                     >
                       Move Right
                       <ArrowRight className="w-4 h-4 ml-1" />
                     </Button>
                   </div>
                 </div>
                 
                 {/* Remove/Restore */}
                 <div className="space-y-4 pt-4 border-t">
                    {selectedClip.isRemoved ? (
                      <Button 
                        variant="secondary" 
                        className="w-full"
                        onClick={() => updateSelectedClip({ isRemoved: false })}
                      >
                        <RotateCcw className="w-4 h-4 mr-2" />
                        Restore to Timeline
                      </Button>
                    ) : (
                      <Button 
                        variant="destructive" 
                        className="w-full bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground border-destructive/20"
                        onClick={() => updateSelectedClip({ isRemoved: true })}
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Remove from Timeline
                      </Button>
                    )}
                 </div>
               </>
            )}
          </div>
        </div>
      </div>
      
      {/* Timeline Filmstrip */}
      <div className="h-48 md:h-56 border-t bg-card flex flex-col shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.5)] z-10 relative">
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
           <span>Timeline Sequence</span>
           <span>{clips.length} Clips</span>
        </div>
        <div className="flex-1 overflow-x-auto p-4 flex gap-3 items-center">
           {clips.map((clip, index) => {
             const isSelected = clip.id === selectedClipId;
             const start = clip.trimStartSeconds || 0;
             const end = clip.trimEndSeconds ?? clip.metadata.duration ?? 0;
             const duration = Math.max(0, end - start);
             
             return (
               <div 
                 key={clip.id}
                 onClick={() => onSelectedClipIdChange(clip.id)}
                 className={cn(
                   "h-full min-w-[160px] md:min-w-[200px] flex-shrink-0 rounded-md border-2 transition-all cursor-pointer overflow-hidden relative flex flex-col bg-black",
                   isSelected ? "border-primary shadow-[0_0_15px_rgba(255,31,98,0.3)] ring-1 ring-primary/50" : "border-border/50 hover:border-border",
                   clip.isRemoved && "opacity-40 grayscale"
                 )}
               >
                 {/* Thumbnail placeholder or video snapshot */}
                 <div className="flex-1 bg-secondary/20 relative">
                    <video 
                      src={clip.outputUrl} 
                      className="w-full h-full object-cover opacity-60"
                      preload="metadata"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    
                    {clip.isRemoved && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <EyeOff className="w-6 h-6 text-white/50" />
                      </div>
                    )}
                    
                    <div className="absolute bottom-2 left-2 right-2 flex justify-between items-end">
                       <div className="bg-black/60 backdrop-blur text-white text-[10px] px-1.5 py-0.5 rounded font-mono shadow-sm">
                         {index + 1}
                       </div>
                       <div className="flex items-center text-[10px] text-white/90 font-mono bg-black/60 backdrop-blur px-1.5 py-0.5 rounded shadow-sm">
                         <Clock className="w-3 h-3 mr-1" />
                         {formatTime(duration)}
                       </div>
                    </div>
                 </div>
                 
                 {/* Label */}
                 <div className="h-8 md:h-10 bg-card px-2 py-1.5 text-[10px] md:text-xs truncate font-medium border-t border-border/50">
                   {clip.metadata.description || `Clip ${index + 1}`}
                 </div>
               </div>
             );
           })}
           
           {clips.length === 0 && (
             <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm italic">
               No clips in this project.
             </div>
           )}
        </div>
      </div>
    </div>
  );
}
