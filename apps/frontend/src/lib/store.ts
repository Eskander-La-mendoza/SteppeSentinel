import { create } from "zustand";

interface WorkspaceState {
  selectedPastureId: string | null;
  selectedObservationId: string | null;
  layer: "ndvi" | "segmentation";
  opacity: number;
  bottomExpanded: boolean;
  editing: boolean;
  setPasture: (id: string | null) => void;
  setObservation: (id: string | null) => void;
  setLayer: (layer: "ndvi"|"segmentation") => void;
  setOpacity: (opacity: number) => void;
  setBottomExpanded: (value: boolean) => void;
  setEditing: (editing: boolean) => void;
}
export const useWorkspace = create<WorkspaceState>((set)=>({
  selectedPastureId:null,selectedObservationId:null,layer:"ndvi",opacity:.82,bottomExpanded:true,editing:false,
  setPasture:(selectedPastureId)=>set({selectedPastureId,selectedObservationId:null,editing:false}),setObservation:(selectedObservationId)=>set({selectedObservationId}),setLayer:(layer)=>set({layer}),setOpacity:(opacity)=>set({opacity}),setBottomExpanded:(bottomExpanded)=>set({bottomExpanded}),setEditing:(editing)=>set({editing})
}));
