import React, { useState, useEffect, useRef } from "react";
import * as BABYLON from "@babylonjs/core";
import { fitCameraToOctree } from "../utils/FitToCamera";
import { findNodeByNumber } from "../utils/FindNodeByNumber";
import { initDB } from "../utils/DbInit";
import { FreeCameraMouseInput } from "../utils/FlyCameraControls";
import { generateUniqueColor } from "../utils/GenerateUniqueColor";
import { createOriginalMeshBoundingBox } from "../utils/CreateOriginalMeshBoundingBox";
import { findNodeInOctree } from "../utils/FindNodeInOctree";
import { cleanupMesh } from "../utils/CleanupMesh";

class PriorityQueue {
  constructor() {
    this.values = [];
  }

  enqueue(element, priority) {
    this.values.push({ element, priority });
    this.sort();
  }

  dequeue() {
    return this.values.shift();
  }

  sort() {
    this.values.sort((a, b) => a.priority - b.priority);
  }

  isEmpty() {
    return this.values.length === 0;
  }
}

function ModelLoader() {
  const [status, setStatus] = useState("");
  const sceneRef = useRef(null);
  const engineRef = useRef(null);
  const canvasRef = useRef(null);
  const [isLoadingLpoly, setIsLoadingLpoly] = useState(false);
  const [fps, setFps] = useState(0);
  const [memory, setMemory] = useState({ total: 0, used: 0 });
  const [cameraType, setCameraType] = useState("fly");
  const [highlightedMesh, setHighlightedMesh] = useState(null);
  const [selectedMeshBounds, setSelectedMeshBounds] = useState([]);
  const [loadedOriginalMeshes, setLoadedOriginalMeshes] = useState({});

  const [targetFPS] = useState(40);
  const [disposalQueue] = useState(new Set());
  const meshCacheRef = useRef(new Map());
  const [disposedMeshes, setDisposedMeshes] = useState(new Set());
  const [culledMeshes, setCulledMeshes] = useState({ total: 0, culled: 0 });
  const loadedMeshesRef = useRef({});
  const isUpdatingRef = useRef(false);
  const pendingCleanups = useRef(new Set());
  let distanceThreshold;

  const [isMousePressed, setIsMousePressed] = useState(false);
  const [mouseButton, setMouseButton] = useState(null);
  const [isLoadingSkipped, setIsLoadingSkipped] = useState(false);
  let isMouseDown = false;

  const distanceThresholdRef = useRef(null);


  const [coverageThreshold, setCoverageThreshold] = useState(0.1); // 1% default threshold
  const lastMousePosition = useRef({ x: 0, y: 0 });
  const lastUpdateTime = useRef(0);
  const hiddenMeshesRef = useRef(new Set());
  const meshMaterialsMap = useRef(new Map());

  // Calculate screen coverage for a mesh
  const calculateMeshScreenCoverage = (mesh, camera, engine) => {
    if (!mesh || !camera || !engine) return 0;

    const boundingBox = mesh.getBoundingInfo().boundingBox;
    const corners = boundingBox.vectorsWorld;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;
    const viewport = engine.getRenderWidth() * engine.getRenderHeight();

    // Project all corners to screen space
    corners.forEach((corner) => {
      const projected = BABYLON.Vector3.Project(
        corner,
        BABYLON.Matrix.Identity(),
        sceneRef.current.getTransformMatrix(),
        camera.viewport.toGlobal(
          engine.getRenderWidth(),
          engine.getRenderHeight()
        )
      );

      minX = Math.min(minX, projected.x);
      minY = Math.min(minY, projected.y);
      maxX = Math.max(maxX, projected.x);
      maxY = Math.max(maxY, projected.y);
    });

    // Calculate screen coverage as percentage
    const screenArea = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
    return screenArea / viewport;
  };
  
  // In your ModelLoader component
  const handlePointerDown = (event) => {
    if (event.button !== 0) return; // Left click only
    
    if (!sceneRef.current?.activeCamera || !engineRef.current) return;
    
    const pickResult = sceneRef.current.pick(
        sceneRef.current.pointerX,
        sceneRef.current.pointerY
    );
    
    if (!pickResult.hit || !pickResult.pickedMesh) return;
    
    const pickedMesh = pickResult.pickedMesh;
    if (!pickedMesh.metadata?.vertexMappings) return;
    console.log(pickedMesh);

    // Get picked face and find corresponding original mesh
    const faceId = pickResult.faceId;
    if (faceId === undefined) return;

    
    const indices = pickedMesh.getIndices();
    const vertexIndex = indices[faceId * 3];
    
    const mapping = pickedMesh.metadata.vertexMappings.find(m => 
        vertexIndex >= m.start && vertexIndex < (m.start + m.count)
    );
    console.log(mapping);
    
    if (mapping) {
        // Clear any previous highlights
        sceneRef.current.meshes.forEach(mesh => {
            if (mesh.clearHighlight) {
                mesh.clearHighlight();
            }
        });
        
        // Highlight only the clicked mesh part
        pickedMesh.highlightOriginalMesh(mapping.meshId);

         // Find mesh name from originalMeshKeys
         const meshInfo = pickedMesh.metadata.originalMeshKeys.find(
          key => key.meshId === mapping.meshId
      );
console.log(meshInfo)
        console.log('Selected mesh part:', {
          meshId: mapping.meshId,
          name: meshInfo?.name || 'Unknown',  // Include the mesh name
          vertexCount: mapping.count,
          nodeNumber: pickedMesh.metadata.nodeNumber,
      });
    }
  };
  
  // Simplify the mesh highlighting functions
  const createHighlightableMergedMesh = (meshData, scene) => {
    const mesh = new BABYLON.Mesh(meshData.name, scene);
    
    // Create vertex data with colors
    const vertexData = new BABYLON.VertexData();
    vertexData.positions = meshData.vertexData.positions;
    vertexData.indices = meshData.vertexData.indices;
    vertexData.normals = meshData.vertexData.normals;
    vertexData.colors = meshData.vertexData.colors;
    vertexData.applyToMesh(mesh);
    
    // Create material that uses vertex colors
    const material = new BABYLON.StandardMaterial(meshData.name + "_material", scene);
    material.useVertexColors = true;
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    mesh.material = material;
    
    // Store vertex mappings in metadata
    mesh.metadata = {
        ...meshData.metadata,
        vertexMappings: meshData.vertexMappings
    };
    
    // Add highlight function to mesh
    mesh.highlightOriginalMesh = function(meshId) {
        const mapping = this.metadata.vertexMappings.find(m => m.meshId === meshId);
        if (!mapping) return;
        
        const colors = this.getVerticesData(BABYLON.VertexBuffer.ColorKind);
        
        // First set all vertices to default color
        for (let i = 0; i < colors.length; i += 4) {
            colors[i] = 1;     // R
            colors[i + 1] = 0.3; // G (reddish for default)
            colors[i + 2] = 0.3; // B
            colors[i + 3] = 1;   // A
        }
        
        // Then highlight only the selected part
        for (let i = mapping.start * 4; i < (mapping.start + mapping.count) * 4; i += 4) {
            colors[i] = 1;     // R (yellow highlight)
            colors[i + 1] = 1; // G
            colors[i + 2] = 0; // B
            colors[i + 3] = 1; // A
        }
        
        this.updateVerticesData(BABYLON.VertexBuffer.ColorKind, colors);
    };
    
    mesh.clearHighlight = function() {
        const colors = this.getVerticesData(BABYLON.VertexBuffer.ColorKind);
        for (let i = 0; i < colors.length; i += 4) {
            colors[i] = 1;     // R
            colors[i + 1] = 0.3; // G
            colors[i + 2] = 0.3; // B
            colors[i + 3] = 1;   // A
        }
        this.updateVerticesData(BABYLON.VertexBuffer.ColorKind, colors);
    };
    
    return mesh;
  };
  // const handlePointerDown = (event) => {
  //   console.log("Pointer down event", event);
  //   // Only handle left click
  //   if (event.button !== 0 && event.button !== 1) return;
    
  //   if (!sceneRef.current?.activeCamera || !engineRef.current) return;
  
  //   setIsMousePressed(true);
  //   const camera = sceneRef.current.activeCamera;
  //   const meshes = sceneRef.current.meshes;
  //   let hiddenCount = 0;
  //   let totalCount = 0;
  
  //   // First pass: calculate coverages
  //   const meshCoverages = new Map();
  //   meshes.forEach(mesh => {
  //     if (mesh.metadata?.isSkippedMesh) {
  //       const coverage = calculateMeshScreenCoverage(mesh, camera, engineRef.current);
  //       meshCoverages.set(mesh.id, coverage);
  //       console.log(`Mesh ${mesh.id} coverage: ${coverage}`);
  //     }
  //   });
  
  //   // Second pass: hide low coverage meshes
  //   meshes.forEach(mesh => {
  //     if (mesh.metadata?.isSkippedMesh) {
  //       totalCount++;
  //       const coverage = meshCoverages.get(mesh.id);
        
  //       try {
  //         if (coverage < 0.005) {
  //           // Store original material if not already stored
  //           if (!meshMaterialsMap.current.has(mesh.id)) {
  //             meshMaterialsMap.current.set(mesh.id, mesh.material);
  //           }
  //           // Hide mesh
  //           hiddenMeshesRef.current.add(mesh.id);
  //           mesh.setEnabled(false);
  //           mesh.isVisible = false;
  //           mesh.isPickable = false;
  //           mesh.visibility = 0;
  //           hiddenCount++;
  //           console.log(`Hiding mesh ${mesh.id}`);
  //         }
  //         mesh.computeWorldMatrix(true);
  //       } catch (error) {
  //         console.error(`Error updating mesh ${mesh.name}:`, error);
  //       }
  //     }
  //   });
  
  //   sceneRef.current.render();
  //   console.log(`Hidden ${hiddenCount} meshes out of ${totalCount}`);
    
  //   // Update culling statistics
  //   setCulledMeshes({
  //     total: totalCount,
  //     culled: hiddenCount
  //   });
  // };
  
  const handlePointerUp = (event) => {
    console.log("Pointer up event", event);
    // Only handle left click
    if (event.button !== 0 && event.button !== 1) return;
    
    if (!sceneRef.current?.activeCamera || !engineRef.current) return;
  
    const meshes = sceneRef.current.meshes;
    let showCount = 0;
    let totalCount = 0;
  
    console.log(`Attempting to restore ${hiddenMeshesRef.current.size} meshes`);
  
    // Restore all hidden meshes
    meshes.forEach(mesh => {
      if (mesh.metadata?.isSkippedMesh) {
        totalCount++;
        if (hiddenMeshesRef.current.has(mesh.id)) {
          try {
            const originalMaterial = meshMaterialsMap.current.get(mesh.id);
            if (originalMaterial) {
              mesh.material = originalMaterial;
            }
            mesh.setEnabled(true);
            mesh.isVisible = true;
            mesh.isPickable = true;
            mesh.visibility = 1;
            showCount++;
            console.log(`Showing mesh ${mesh.id}`);
            hiddenMeshesRef.current.delete(mesh.id);
          } catch (error) {
            console.error(`Error restoring mesh ${mesh.name}:`, error);
          }
          mesh.computeWorldMatrix(true);
        }
      }
    });
  
    sceneRef.current.render();
    setIsMousePressed(false);
    console.log(`Restored ${showCount} meshes out of ${totalCount}`);
  
    // Update culling statistics
    setCulledMeshes({
      total: totalCount,
      culled: 0
    });
  };
  
  // Setup pointer observers
  const setupPointerObservers = () => {
    if (!sceneRef.current) return;
  
    // Clear any existing observers
    if (sceneRef.current.onPointerObservable) {
      sceneRef.current.onPointerObservable.clear();
    }
  
    // Add new observers
    sceneRef.current.onPointerObservable.add((pointerInfo) => {
      switch (pointerInfo.type) {
        case BABYLON.PointerEventTypes.POINTERDOWN:
          handlePointerDown(pointerInfo.event);
          break;
        case BABYLON.PointerEventTypes.POINTERUP:
          handlePointerUp(pointerInfo.event);
          break;
      }
    });
  };
  
  // Call setupPointerObservers after loading meshes
  useEffect(() => {
    if (sceneRef.current) {
      setupPointerObservers();
    }
  }, [sceneRef.current]);

// Update your scene initialization in useEffect
useEffect(() => {
  if (!sceneRef.current) return;

  const scene = sceneRef.current;

  // Use Babylon.js pointer events instead of DOM events
  scene.onPointerObservable.add((pointerInfo) => {
    switch (pointerInfo.type) {
      case BABYLON.PointerEventTypes.POINTERDOWN:
        handlePointerDown(pointerInfo.event);
        break;
      case BABYLON.PointerEventTypes.POINTERUP:
        handlePointerUp(pointerInfo.event);
        break;
    }
  });

  return () => {
    if (scene) {
      scene.onPointerObservable.clear();
    }
  };
}, []);


  // Function to highlight a mesh
  const highlightMesh = (mesh) => {
    // Remove previous highlight if exists
    if (highlightedMesh && highlightedMesh !== mesh) {
      unhighlightMesh();
    }

    if (mesh && mesh !== highlightedMesh) {
      // Create highlight material
      const highlightMaterial = new BABYLON.StandardMaterial(
        "highlightMaterial",
        sceneRef.current
      );
      highlightMaterial.diffuseColor = new BABYLON.Color3(1, 1, 0); // Yellow highlight
      highlightMaterial.specularColor = new BABYLON.Color3(0.5, 0.5, 0.5);
      highlightMaterial.emissiveColor = new BABYLON.Color3(0.3, 0.3, 0);
      highlightMaterial.backFaceCulling = false;
      highlightMaterial.twoSidedLighting = true;

      // Store original material and apply highlight
      mesh.originalMaterial = mesh.material;
      mesh.material = highlightMaterial;
      setHighlightedMesh(mesh);

    
    }
  };

  // Function to remove highlight
  const unhighlightMesh = () => {
    if (highlightedMesh) {
      highlightedMesh.material = highlightedMesh.originalMaterial;
      setHighlightedMesh(null);
    }
  };
  // Add camera toggle function
  const toggleCamera = (type) => {
    if (!sceneRef.current || !engineRef.current) return;

    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const currentCamera = scene.activeCamera;
    const cameraPosition = currentCamera.position.clone();
    const cameraTarget = currentCamera.target
      ? currentCamera.target.clone()
      : currentCamera.getTarget().clone();
    const cameraRadius = currentCamera.radius;

    currentCamera.dispose();

    let newCamera;
    if (type === "fly") {
      newCamera = new BABYLON.FreeCamera("flyCamera", cameraPosition, scene);
      newCamera.setTarget(cameraTarget);

      const mouseInput = new FreeCameraMouseInput();
      mouseInput.camera = newCamera;

      newCamera.inputs.clear();
      newCamera.inputs.add(mouseInput);

      newCamera.speed = 0.2;
      newCamera.inertia = 0.5;
      newCamera.angularSensibility = 2000;
      newCamera.minZ = 0.1;
      newCamera.maxZ = 400;
      newCamera.fov=0.8
    } else {
      newCamera = new BABYLON.ArcRotateCamera(
        "arcCamera",
        Math.PI / 4,
        Math.PI / 3,
        cameraRadius || 10,
        cameraTarget,
        scene
      );
      newCamera.setPosition(cameraPosition);

      newCamera.inertia = 0.5;
      newCamera.angularSensibilityX = 500;
      newCamera.angularSensibilityY = 500;
      newCamera.wheelPrecision = 50;
      newCamera.panningSensibility = 50;
      newCamera.panningInertia = 0.5;

      // Smooth movement constraints
      newCamera.lowerRadiusLimit = 1;
      newCamera.upperRadiusLimit = 100;
      newCamera.wheelDeltaPercentage = 0.01;
      newCamera.pinchDeltaPercentage = 0.01;
    }

    // Common camera settings
   
    newCamera.attachControl(canvas, false); // Set to false to prevent right-click context menu

    // Enable smooth interpolation
    scene.fogEnabled = true;
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
    scene.fogDensity = 0.001;

    // Optimize scene for smoother rendering
    scene.skipFrustumClipping = true;
    scene.blockMaterialDirtyMechanism = true;

    scene.activeCamera = newCamera;
    setCameraType(type);
  };

  const createWireframeBox = (bounds) => {
    if (!bounds || !sceneRef.current) return null;

    const min = bounds.min;
    const max = bounds.max;

    const size = {
      width: Math.abs(max.x - min.x),
      height: Math.abs(max.y - min.y),
      depth: Math.abs(max.z - min.z),
    };

    const center = new BABYLON.Vector3(
      (max.x + min.x) / 2,
      (max.y + min.y) / 2,
      (max.z + min.z) / 2
    );

    const box = BABYLON.MeshBuilder.CreateBox(
      "rootOctreeBox",
      size,
      sceneRef.current
    );

    box.position = center;
    const material = new BABYLON.StandardMaterial(
      "rootWireframeMat",
      sceneRef.current
    );
    material.wireframe = true;
    material.alpha = 0.3;
    material.emissiveColor = new BABYLON.Color3(1, 0, 0);

    box.material = material;
    box.isPickable = false;
    return box;
  };

  // Updated version of updatePerformanceMetrics
  const updatePerformanceMetrics = () => {
    if (engineRef.current && sceneRef.current) {
      // Update FPS
      setFps(Math.round(engineRef.current.getFps()));

      // Calculate total memory from all meshes
      const sceneMemory = sceneRef.current.meshes.reduce((acc, mesh) => {
        const vertexCount = mesh.getTotalVertices();
        const indexCount = mesh.getTotalIndices();

        // Calculate memory for this mesh:
        // Positions (3 floats) + Normals (3 floats) + UVs (2 floats) = 8 floats per vertex
        // Each float is 4 bytes
        const vertexMemory = vertexCount * 8 * 4;
        // Each index is a 32-bit integer (4 bytes)
        const indexMemory = indexCount * 4;

        return acc + vertexMemory + indexMemory;
      }, 0);

      // Convert to MB
      const totalMemoryMB = (sceneMemory / (1024 * 1024)).toFixed(2);

      // Calculate used memory (from enabled meshes only)
      const usedMemory = sceneRef.current.meshes.reduce((acc, mesh) => {
        if (mesh.isEnabled()) {
          const vertexCount = mesh.getTotalVertices();
          const indexCount = mesh.getTotalIndices();
          const vertexMemory = vertexCount * 8 * 4;
          const indexMemory = indexCount * 4;
          return acc + vertexMemory + indexMemory;
        }
        return acc;
      }, 0);

      const usedMemoryMB = (usedMemory / (1024 * 1024)).toFixed(2);

      setMemory({
        total: totalMemoryMB,
        used: usedMemoryMB,
      });
    }
  };

  // Add this component for the performance display
  const PerformanceMonitor = ({ fps, memory, culledMeshes }) => (
    <div className="text-danger border p-2">
      <div>FPS: {fps}</div>
      <div>
        Memory: {memory.used}MB / {memory.total}MB
      </div>
      <div>
        Culled Meshes: {culledMeshes.culled} / {culledMeshes.total}
      </div>
    </div>
  );

  let nodesToProcess = [];

  const FindDepth4nodes = async()=>{
    
  try {
    const db = await initDB();
    const tx = db.transaction(['octree'], 'readonly');
    const octreeStore = tx.objectStore('octree');
    
    const octreeData = await octreeStore.get('mainOctree');
    if (!octreeData?.data) return;

    // Get all depth 4 nodes from octree
    const stack = [{ block: octreeData.data.blockHierarchy, depth: 0 }];

    while (stack.length > 0) {
      const { block, depth } = stack.pop();

      if (depth === 4) {
        nodesToProcess.push({
          nodeNumber: block.properties.nodeNumber,
          bounds: block.bounds,
          meshInfos: block.meshInfos || []
        });
      } else if (depth < 4 && block.relationships?.childBlocks) {
        stack.push(...block.relationships.childBlocks.map(child => ({
          block: child,
          depth: depth + 1
        })));
      }
    }

  } catch (error) {
    console.error('Error in checkAndLoadMeshes:', error);
  } finally {
    isUpdatingRef.current = false;
  }
  }

  useEffect(() => {
    if (!canvasRef.current) return;

    const engine = new BABYLON.Engine(canvasRef.current, true);
    engineRef.current = engine;

    const scene = new BABYLON.Scene(engine);
    sceneRef.current = scene;

    // Basic scene optimizations
    scene.skipFrustumClipping = false; // Enable frustum clipping
    scene.blockMaterialDirtyMechanism = true;
    scene.useGeometryIdsMap = true;
    scene.useMaterialMeshMap = true;
    scene.useClonedMeshMap = true;

    // Enable automatic frustum culling optimization
    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;

    // In your scene initialization
    scene.skipFrustumClipping = false;
    // Enable hardware scaling
    engine.setHardwareScalingLevel(1.0);
    engine.adaptToDeviceRatio = true;
    engine.enableOfflineSupport = false;

    const camera = new BABYLON.ArcRotateCamera(
      "camera",
      0,
      Math.PI / 3,
      10,
      BABYLON.Vector3.Zero(),
      scene
    );
    camera.attachControl(canvasRef.current, true);

    // Main hemispheric light from above
    const topLight = new BABYLON.HemisphericLight(
      "topLight",
      new BABYLON.Vector3(0, 1, 0),
      scene
    );
    topLight.intensity = 0.7;

    // Secondary hemispheric light from below for better back-face illumination
    const bottomLight = new BABYLON.HemisphericLight(
      "bottomLight",
      new BABYLON.Vector3(0, -1, 0),
      scene
    );
    bottomLight.intensity = 0.3;

    // Setup fog
    scene.fogEnabled = true;
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP;
    scene.fogDensity = 0.001;

    // Set up performance monitoring interval
    const monitorInterval = setInterval(updatePerformanceMetrics, 1000);

    FindDepth4nodes();

    // Add observer to track camera position changes
    scene.onBeforeRenderObservable.add(() => {
      const nearestNodes = getNearestNodes(scene.activeCamera, scene.meshes);
    });
   
     // Add observer for camera movement and zoom
     scene.onBeforeRenderObservable.add(() => {
      updateMeshVisibility();
      
      // Check camera movement for dynamic mesh visibility
      if (scene.activeCamera) {
        const camera = scene.activeCamera;
        const meshes = scene.meshes;
        
        meshes.forEach(mesh => {
          if (mesh.metadata?.isSkippedMesh && hiddenMeshesRef.current.has(mesh.id)) {
            const distance = getDistanceToCamera(mesh, camera);
            // const coverage = calculateMeshScreenCoverage(mesh, camera, engine);
            const coverage = mesh.metadata.screenCoverage;
            console.log(coverage)

            // Show mesh if zoomed in close enough or has good coverage
            if (distance <=  distanceThresholdRef.current*0.9 || coverage <= 0.5) {
              const originalMaterial = meshMaterialsMap.current.get(mesh.id);
              if (originalMaterial) {
                mesh.material = originalMaterial;
              }
              mesh.setEnabled(true);
              mesh.isVisible = true;
              mesh.isPickable = true;
              mesh.visibility = 1;
              hiddenMeshesRef.current.delete(mesh.id);
              mesh.computeWorldMatrix(true);
            }
            else {
              // Hide mesh when too far or low coverage
              if (!hiddenMeshesRef.current.has(mesh.id)) {
                if (!meshMaterialsMap.current.has(mesh.id)) {
                  meshMaterialsMap.current.set(mesh.id, mesh.material);
                }
                mesh.setEnabled(false);
                mesh.isVisible = false;
                mesh.isPickable = false;
                mesh.visibility = 0;
                hiddenMeshesRef.current.add(mesh.id);
                mesh.computeWorldMatrix(true);
              }
            }
          }
        });
      }
    });

    let lastCameraPosition = null;
    const MOVEMENT_THRESHOLD = 1; // Adjust this value based on your needs

  
    // scene.onBeforeRenderObservable.add(() => {
    //   if (!scene.activeCamera) return;

    //   const currentPosition = scene.activeCamera.position.clone();

    //   if (
    //     !lastCameraPosition ||
    //     BABYLON.Vector3.Distance(currentPosition, lastCameraPosition) >
    //       MOVEMENT_THRESHOLD
    //   ) {
    //     // Get meshes with metadata
    //     const meshesWithMetadata = scene.meshes.filter(
    //       (mesh) => mesh.metadata?.nodeNumber && !mesh.metadata.isSkippedMesh
    //     );

    //     // Map distances
    //     const meshesWithDistances = meshesWithMetadata.map((mesh) => ({
    //       nodeNumber: mesh.metadata.nodeNumber,
    //       distance: getDistanceToCamera(mesh, scene.activeCamera),
    //     }));

    //     // Filter by distance and sort by priority
    //     const withinDistance = meshesWithDistances
    //       .filter((node) => node.distance <=  distanceThresholdRef.current)
    //       .sort((a, b) => a.distance - b.distance)
    //       .slice(0, MAX_CONCURRENT_LOADS); // Limit number of concurrent loads

    //     // Load high-priority nodes first
    //     withinDistance.forEach((node) => {
    //       const exists = scene.meshes.some(
    //         (mesh) =>
    //           mesh.metadata?.nodeNumber === node.nodeNumber &&
    //           mesh.metadata.isSkippedMesh
    //       );

    //       if (!exists && !loadedSkippedNodesRef.current.has(node.nodeNumber)) {
    //         loadSkippedMeshesForNode(node.nodeNumber);
    //       }
    //     });

  
    //     // Cleanup distant meshes
    //     const maxDistance =  distanceThresholdRef.current; // Buffer zone  distanceThreshold  * 1.5
    //     scene.meshes.forEach((mesh) => {
    //       if (mesh.metadata?.isSkippedMesh) {
    //         const distance = getDistanceToCamera(mesh, scene.activeCamera);
    //         if (distance > maxDistance) {
    //           mesh.dispose();
    //         }
    //       }
    //     });

    //     lastCameraPosition = currentPosition;
    //   }
    // });

    scene.onBeforeRenderObservable.add(async () => {
      if (!scene.activeCamera) return;
    
      const currentPosition = scene.activeCamera.position.clone();
    
      if (!lastCameraPosition ||
          BABYLON.Vector3.Distance(currentPosition, lastCameraPosition) > MOVEMENT_THRESHOLD) {
        try {
          const db = await initDB();
          
          // Create a single transaction for the entire operation
          const transaction = db.transaction(["mergedSkippedMeshes"], "readonly");
          const skippedStore = transaction.objectStore("mergedSkippedMeshes");
    
          // Calculate distances and filter nodes
          const nodesWithDistances = nodesToProcess.map(node => ({
            nodeNumber: node.nodeNumber,
            distance: BABYLON.Vector3.Distance(
              calculateNodeCenter(node.bounds),
              currentPosition
            ),
            bounds: node.bounds
          }));
    
          const withinDistance = nodesWithDistances
            .filter(node => node.distance <= distanceThresholdRef.current * 0.8)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, MAX_CONCURRENT_LOADS);
    
          // Process nodes in parallel
          await Promise.all(withinDistance.map(async node => {
            if (!scene.meshes.some(
              mesh => mesh.metadata?.nodeNumber === node.nodeNumber && mesh.isSkippedMesh
            )) {
              await loadSkippedMeshesForNode(node.nodeNumber, db);
            }
          }));
    
          // Update camera position and cleanup distant meshes
          lastCameraPosition = currentPosition;
          const maxDistance = distanceThresholdRef.current;
          
          scene.meshes.forEach(mesh => {
            if (mesh.metadata?.isSkippedMesh) {
              const meshNode = nodesWithDistances.find(
                n => n.nodeNumber === mesh.metadata.nodeNumber
              );
              if (meshNode && meshNode.distance > maxDistance) {
                mesh.dispose();
              }
            }
          });
    
        } catch (error) {
          console.error("Error in octree traversal:", error);
        }
      }
    });

    
    engine.runRenderLoop(() => {
      if (sceneRef.current.meshes.length > 0) {
        scene.render();
      }
    });

    window.addEventListener("resize", () => {
      engine.resize();
    });

    return () => {
      clearInterval(monitorInterval);
      scene.onBeforeRenderObservable.clear();
      engine.dispose();
      scene.dispose();
      // container.remove();
    };
  }, []);

  // Function to calculate node center
const calculateNodeCenter = (bounds) => {
  return new BABYLON.Vector3(
    (bounds.max.x + bounds.min.x) / 2,
    (bounds.max.y + bounds.min.y) / 2,
    (bounds.max.z + bounds.min.z) / 2
  );
};

  // Setup scene click handling
  // useEffect(() => {
  //   if (!sceneRef.current) return;

  //   const scene = sceneRef.current;

  //   scene.onPointerDown = (evt) => {
  //     if (evt.button !== 0) return; // Only handle left click

  //     const pickResult = scene.pick(scene.pointerX, scene.pointerY);

  //     if (pickResult.hit && pickResult.pickedMesh) {
  //       highlightMesh(pickResult.pickedMesh);
  //       // loadOriginalMeshBoundingBoxes(pickResult.pickedMesh);
  //     } else {
  //       unhighlightMesh();
  //       clearBoundingBoxes();
  //     }
  //   };

  //   return () => {
  //     if (scene) {
  //       scene.onPointerDown = null;
  //     }
  //   };
  // }, [highlightedMesh]);

 const isNodeInFrustum = (bounds, camera) => {
    try {
      // Create temporary box for frustum check
      const min = new BABYLON.Vector3(bounds.min.x, bounds.min.y, bounds.min.z);
      const max = new BABYLON.Vector3(bounds.max.x, bounds.max.y, bounds.max.z);
      const boundingBox = new BABYLON.BoundingBox(min, max);
      
      // Check if box intersects with camera frustum
      return camera.isInFrustum(boundingBox);
    } catch (error) {
      console.error("Error checking frustum:", error);
      return false;
    }
  };


  // load merged lowpoly meshes to the scene
  const loadedSkippedNodesRef = useRef(new Set());
  const skippedMeshLoadingRef = useRef(new Set());
  const MAX_CONCURRENT_LOADS = 5;
  const loadSkippedMeshesForNode = async (nodeNumber, db) => {
    if (
      loadedSkippedNodesRef.current.has(nodeNumber) ||
      skippedMeshLoadingRef.current.has(nodeNumber) ||
      skippedMeshLoadingRef.current.size >= MAX_CONCURRENT_LOADS
    ) {
      return;
    }
  
    try {
      skippedMeshLoadingRef.current.add(nodeNumber);
      
      // Create a new transaction for this operation
      const transaction = db.transaction("mergedSkippedMeshes", "readonly");
      const skippedStore = transaction.objectStore("mergedSkippedMeshes");
  
      // Set up transaction error handling
      transaction.onerror = (event) => {
        console.error("Transaction error:", event.target.error);
      };
  
      // Get the mesh data
      const key = `merged_skipped_${nodeNumber}`;
      const skippedMeshData = await skippedStore.get(key);
  
      if (!skippedMeshData) {
        return;
      }
  
      // Check for existing mesh
      const existingMesh = sceneRef.current?.meshes.find(
        mesh => mesh.metadata?.nodeNumber === nodeNumber && mesh.metadata?.isSkippedMesh
      );
  
      if (!existingMesh && sceneRef.current) {
        const vertexCount = skippedMeshData.vertexData.positions.length / 3;
        
        // Calculate color based on node number for consistency
        const color = generateUniqueColor(nodeNumber % 100, 100);
        
        // Create colors array with the unique color
        const colors = new Float32Array(vertexCount * 4);
        for (let i = 0; i < vertexCount * 4; i += 4) {
          colors[i] = color.r;     // R
          colors[i + 1] = color.g; // G
          colors[i + 2] = color.b; // B
          colors[i + 3] = 1;       // A
        }
        
        skippedMeshData.vertexData.colors = colors;
        
        // Create mesh with the unique color
        const mesh = createHighlightableMergedMesh(
          skippedMeshData, 
          sceneRef.current,
          nodeNumber,  // Pass nodeNumber for consistent coloring
          100         // Total possible nodes for color distribution
        );
  
        if (mesh) {
          // Store metadata
          mesh.metadata = {
            ...mesh.metadata,
            nodeNumber: parseInt(skippedMeshData.name.split("_")[2]),
            isSkippedMesh: true,
            originalColor: color,
            vertexMappings: skippedMeshData.metadata.originalMeshKeys.map((key, index) => ({
              meshId: key.meshId,
              start: index * (vertexCount / skippedMeshData.metadata.originalMeshCount),
              count: vertexCount / skippedMeshData.metadata.originalMeshCount
            })),
            originalMeshCount: skippedMeshData.metadata.originalMeshCount,
            originalMeshKeys: skippedMeshData.metadata.originalMeshKeys
          };
  
          // Set up cleanup
          mesh.onDisposeObservable.add(() => {
            loadedSkippedNodesRef.current.delete(nodeNumber);
            meshMaterialsMap.current.delete(mesh.id);
          });
        }
      }
  
      // Add to loaded nodes set
      loadedSkippedNodesRef.current.add(nodeNumber);
      
    } catch (error) {
      console.error(`Error loading skipped mesh for node ${nodeNumber}:`, error);
    } finally {
      skippedMeshLoadingRef.current.delete(nodeNumber);
    }
  };

  function generateVertexColor(vertexIndex, totalVertices, meshId) {
    // Use golden ratio for better color distribution
    const goldenRatio = 0.618033988749895;
    
    // Generate different hues based on vertex position and meshId
    const hue = ((vertexIndex / totalVertices) + (meshId * goldenRatio)) % 1;
    const saturation = 0.7 + Math.sin(vertexIndex * 0.1) * 0.3; // Vary saturation
    const lightness = 0.5 + Math.cos(vertexIndex * 0.1) * 0.2;  // Vary lightness
    
    // Convert HSL to RGB
    function hslToRgb(h, s, l) {
        let r, g, b;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }

        return { r, g, b };
    }

    return hslToRgb(hue, saturation, lightness);
}

  const loadMergedPolyMeshes = async () => {
    if (!sceneRef.current || !engineRef.current) {
      setStatus("Error: Scene or Engine not initialized");
      return;
    }

    setIsLoadingLpoly(true);
    setStatus("Starting to load merged low-poly models...");

    try {
      const db = await initDB();

      // Get octree data first
      const octreeStore = db
        .transaction("octree", "readonly")
        .objectStore("octree");
      const octreeData = await octreeStore.get("mainOctree");

      if (!octreeData?.data) {
        throw new Error("No octree data found");
      }

      // Create root wireframe box for visualization
      createWireframeBox(octreeData.bounds);

      // Get all merged lpoly meshes
      const mergedStore = db
        .transaction("mergedlowPoly", "readonly")
        .objectStore("mergedlowPoly");
      const allMergedMeshes = await mergedStore.getAll();

      if (!allMergedMeshes?.length) {
        throw new Error("No merged meshes found in database");
      }

      setStatus(`Found ${allMergedMeshes.length} merged meshes`);

      for (const mergedMeshData of allMergedMeshes) {
        try {
            // Add vertex colors to mesh data
            const vertexCount = mergedMeshData.vertexData.positions.length / 3;
            const colors = new Float32Array(vertexCount * 4);
            
            
            // Set default white color
            for (let i = 0; i < vertexCount * 4; i += 4) {
                colors[i] = 1;     // R
                colors[i + 1] = 1; // G
                colors[i + 2] = 1; // B
                colors[i + 3] = 1; // A
            }
            
            mergedMeshData.vertexData.colors = colors;
            
            // Create mesh with highlighting capability
            const mesh = createHighlightableMergedMesh(mergedMeshData, sceneRef.current);
            
            // Store vertex mappings
            mesh.metadata = {
                ...mesh.metadata,
                nodeNumber: parseInt(mergedMeshData.name.split("_")[2]),
                isUnSkippedMesh: true,
                vertexMappings: mergedMeshData.metadata.originalMeshKeys.map((key, index) => ({
                    meshId: key.meshId,
                    start: index * (vertexCount / mergedMeshData.metadata.originalMeshCount),
                    count: vertexCount / mergedMeshData.metadata.originalMeshCount
                }))
            };
        } catch (error) {
            console.error('Error creating mesh:', error);
        }
    }

      // // Process each merged mesh
      // for (let i = 0; i < allMergedMeshes.length; i++) {
      //   const mergedMeshData = allMergedMeshes[i];
      //   try {
      //     const nodeNumber = parseInt(mergedMeshData.name.split("_")[2]);
      //     const targetNode = findNodeByNumber(
      //       octreeData.data.blockHierarchy,
      //       nodeNumber
      //     );

      //     if (!targetNode) {
      //       console.warn(`Node ${nodeNumber} not found in octree`);
      //       continue;
      //     }

      //     // Create mesh
      //     const mesh = new BABYLON.Mesh(mergedMeshData.name, sceneRef.current);

      //     // Apply vertex data
      //     const vertexData = new BABYLON.VertexData();
      //     vertexData.positions = new Float32Array(
      //       mergedMeshData.vertexData.positions
      //     );
      //     vertexData.indices = new Uint32Array(
      //       mergedMeshData.vertexData.indices
      //     );

      //     if (mergedMeshData.vertexData.normals) {
      //       vertexData.normals = new Float32Array(
      //         mergedMeshData.vertexData.normals
      //       );
      //     }

      //     vertexData.applyToMesh(mesh);

      //     // Apply transforms
      //     if (mergedMeshData.transforms.worldMatrix) {
      //       const matrix = BABYLON.Matrix.FromArray(
      //         mergedMeshData.transforms.worldMatrix
      //       );
      //       mesh.setPreTransformMatrix(matrix);
      //     } else {
      //       mesh.position = new BABYLON.Vector3(
      //         mergedMeshData.transforms.position.x,
      //         mergedMeshData.transforms.position.y,
      //         mergedMeshData.transforms.position.z
      //       );
      //       mesh.rotation = new BABYLON.Vector3(
      //         mergedMeshData.transforms.rotation.x,
      //         mergedMeshData.transforms.rotation.y,
      //         mergedMeshData.transforms.rotation.z
      //       );
      //       mesh.scaling = new BABYLON.Vector3(
      //         mergedMeshData.transforms.scaling.x,
      //         mergedMeshData.transforms.scaling.y,
      //         mergedMeshData.transforms.scaling.z
      //       );
      //     }

          
      //     // Create unique material for each mesh
      //     const material = new BABYLON.StandardMaterial(
      //       `material_${nodeNumber}`,
      //       sceneRef.current
      //     );
      //     const meshColor = generateUniqueColor(i, allMergedMeshes.length);

      //     material.diffuseColor = meshColor;
      //     material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
      //     material.ambientColor = new BABYLON.Color3(0.1, 0.1, 0.1);
      //     material.backFaceCulling = false;
      //     // Enable two-sided lighting
      //     material.twoSidedLighting = true;
      //     // Add some metallic effect
      //     material.specularPower = 32;
      //     material.useSpecularOverAlpha = true;

      //     // Apply material
      //     mesh.material = material;
      //     mesh.isPickable = true;
      //     mesh.isVisible = true;

      //     // Store metadata including node information and color
      //     mesh.metadata = {
      //       nodeNumber: nodeNumber,
      //       originalMeshCount: mergedMeshData.metadata.originalMeshCount,
      //       nodeBounds: targetNode.bounds,
      //       originalMeshKeys: mergedMeshData.metadata.originalMeshKeys,
      //     };

      //     setStatus(`Processed ${i + 1} of ${allMergedMeshes.length} meshes`);
      //   } catch (error) {
      //     console.error(`Error creating mesh from merged data:`, error);
      //   }
      // }

      // Position camera to fit the scene
      if (sceneRef.current.activeCamera && octreeData.bounds) {
        const distance = fitCameraToOctree(
          sceneRef.current.activeCamera,
          octreeData.bounds.max,
          octreeData.bounds.min
        );
        distanceThresholdRef.current = distance;
      }

      setStatus("Successfully loaded all colored merged low-poly meshes");
      sceneRef.current.render();
    } catch (error) {
      console.error("Error loading merged lpoly models:", error);
      setStatus(`Error: ${error.message}`);
    } finally {
      setIsLoadingLpoly(false);
    }
  };

  const loadSkippedMergedPolyMeshes = async () => {
    if (!sceneRef.current || !engineRef.current) {
      setStatus("Error: Scene or Engine not initialized");
      return;
    }

    setIsLoadingLpoly(true);
    setStatus("Starting to load merged skipped low-poly models...");

    try {
      const db = await initDB();

      // Get octree data first
      const octreeStore = db
        .transaction("octree", "readonly")
        .objectStore("octree");
      const octreeData = await octreeStore.get("mainOctree");

      if (!octreeData?.data) {
        throw new Error("No octree data found");
      }

      // Get all merged skipped lpoly meshes
      const mergedStore = db
        .transaction("mergedSkippedMeshes", "readonly")
        .objectStore("mergedSkippedMeshes");
      const allMergedMeshes = await mergedStore.getAll();
      console.log(allMergedMeshes);

      if (!allMergedMeshes?.length) {
        throw new Error("No merged skipped meshes found in database");
      }

      setStatus(`Found ${allMergedMeshes.length} merged skipped meshes`);

      // Process each merged mesh
      for (let i = 0; i < allMergedMeshes.length; i++) {
        const mergedMeshData = allMergedMeshes[i];
        try {
          const nodeNumber = parseInt(mergedMeshData.name.split("_")[2]);
          const targetNode = findNodeByNumber(
            octreeData.data.blockHierarchy,
            nodeNumber
          );

          if (!targetNode) {
            console.warn(`Node ${nodeNumber} not found in octree`);
            continue;
          }
          // Create root wireframe box for visualization
          createWireframeBox(octreeData.bounds);
          // Create mesh
          const mesh = new BABYLON.Mesh(mergedMeshData.name, sceneRef.current);

          // Apply vertex data
          const vertexData = new BABYLON.VertexData();
          vertexData.positions = new Float32Array(
            mergedMeshData.vertexData.positions
          );
          vertexData.indices = new Uint32Array(
            mergedMeshData.vertexData.indices
          );

          if (mergedMeshData.vertexData.normals) {
            vertexData.normals = new Float32Array(
              mergedMeshData.vertexData.normals
            );
          }

          vertexData.applyToMesh(mesh);

          // Apply transforms
          if (mergedMeshData.transforms.worldMatrix) {
            const matrix = BABYLON.Matrix.FromArray(
              mergedMeshData.transforms.worldMatrix
            );
            mesh.setPreTransformMatrix(matrix);
          } else {
            mesh.position = new BABYLON.Vector3(
              mergedMeshData.transforms.position.x,
              mergedMeshData.transforms.position.y,
              mergedMeshData.transforms.position.z
            );
            mesh.rotation = new BABYLON.Vector3(
              mergedMeshData.transforms.rotation.x,
              mergedMeshData.transforms.rotation.y,
              mergedMeshData.transforms.rotation.z
            );
            mesh.scaling = new BABYLON.Vector3(
              mergedMeshData.transforms.scaling.x,
              mergedMeshData.transforms.scaling.y,
              mergedMeshData.transforms.scaling.z
            );
          }

          // Create unique material for each mesh with a different color scheme
          const material = new BABYLON.StandardMaterial(
            `material_skipped_${nodeNumber}`,
            sceneRef.current
          );
          // Use a different color scheme for skipped meshes (e.g., more reddish)
          const meshColor = generateUniqueColor(
            i,
            allMergedMeshes.length,
            0.7,
            0.3,
            0.3
          ); // Adjust base colors

          material.diffuseColor = meshColor;
          material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
          material.ambientColor = new BABYLON.Color3(0.1, 0.1, 0.1);
          material.backFaceCulling = false;
          material.twoSidedLighting = true;
          material.specularPower = 32;
          material.useSpecularOverAlpha = true;

          // Apply material
          mesh.material = material;
          mesh.isPickable = true;
          mesh.isVisible = true;

          // Store metadata including node information and color
          mesh.metadata = {
            nodeNumber: nodeNumber,
            originalMeshCount: mergedMeshData.metadata.originalMeshCount,
            nodeBounds: targetNode.bounds,
            originalMeshKeys: mergedMeshData.metadata.originalMeshKeys,
            isSkippedMesh: true, // Add flag to identify skipped meshes
          };

          setStatus(
            `Processed ${i + 1} of ${allMergedMeshes.length} skipped meshes`
          );
        } catch (error) {
          console.error(`Error creating mesh from merged skipped data:`, error);
        }
      }

      // Position camera to fit the scene
      if (sceneRef.current.activeCamera && octreeData.bounds) {
        const distance = fitCameraToOctree(
          sceneRef.current.activeCamera,
          octreeData.bounds.max,
          octreeData.bounds.min
        );
        distanceThreshold = distance;
      }
        // After successfully loading meshes, setup pointer observers
    setupPointerObservers();
      setStatus(
        "Successfully loaded all colored merged skipped low-poly meshes"
      );
      sceneRef.current.render();
    } catch (error) {
      console.error("Error loading merged skipped lpoly models:", error);
      setStatus(`Error: ${error.message}`);
    } finally {
      setIsLoadingLpoly(false);
    }
  };

  const clearBoundingBoxes = () => {
    selectedMeshBounds.forEach((box) => box.dispose());
    setSelectedMeshBounds([]);
  };

  const loadOriginalMeshBoundingBoxes = async (mergedMesh) => {
    if (!sceneRef.current || !mergedMesh.metadata?.originalMeshKeys) return;

    try {
      const db = await initDB();
      const originalMeshStore = db
        .transaction("originalMeshes", "readonly")
        .objectStore("originalMeshes");

      clearBoundingBoxes();

      const newBoundingBoxes = [];
      const promises = mergedMesh.metadata.originalMeshKeys.map(
        async (meshKey) => {
          try {
            const originalMeshData = await originalMeshStore.get(
              meshKey.meshId
            );

            if (originalMeshData?.data?.boundingBox) {
              const color = new BABYLON.Color3(
                Math.random() * 0.5 + 0.5,
                Math.random() * 0.5 + 0.5,
                Math.random() * 0.5 + 0.5
              );

              const box = createOriginalMeshBoundingBox(
                originalMeshData.data.boundingBox,
                sceneRef.current,
                color,
                {
                  meshId: meshKey.meshId,
                  fileName: meshKey.fileName,
                  originalMeshData: originalMeshData.data,
                }
              );

              newBoundingBoxes.push(box);
            }
          } catch (error) {
            console.error(
              `Error creating bounding box for mesh ${meshKey.meshId}:`,
              error
            );
          }
        }
      );

      await Promise.all(promises);
      setSelectedMeshBounds(newBoundingBoxes);

      // Add click handler for bounding boxes
      sceneRef.current.onPointerDown = (evt) => {
        if (evt.button !== 0) return;

        const pickResult = sceneRef.current.pick(
          sceneRef.current.pointerX,
          sceneRef.current.pointerY
        );

        if (pickResult.hit) {
          const pickedMesh = pickResult.pickedMesh;

          // Handle clicking on bounding boxes
          if (pickedMesh.metadata?.isOriginalBoundingBox) {
            // Highlight clicked box and unhighlight others
            newBoundingBoxes.forEach((box) => {
              if (box === pickedMesh) {
                box.material = box.highlightMaterial;
                console.log("Selected original mesh:", box.metadata);
              } else {
                box.material = box.defaultMaterial;
              }
            });
          } else {
            // Handle clicking on merged mesh
            highlightMesh(pickedMesh);
          }
        } else {
          // Reset all boxes to default material
          newBoundingBoxes.forEach((box) => {
            box.material = box.defaultMaterial;
          });
          unhighlightMesh();
        }
      };
    } catch (error) {
      console.error("Error loading original mesh bounding boxes:", error);
    }
  };

  // Add this function to check distance between camera and mesh
  const getDistanceToCamera = (mesh, camera) => {
    const meshPosition = mesh.getBoundingInfo().boundingSphere.centerWorld;
    return BABYLON.Vector3.Distance(meshPosition, camera.position);
  };

  // Modified loadOriginalMeshes with caching
  const loadOriginalMeshes = async (mergedMesh) => {
    console.log("original");
    const nodeNumber = mergedMesh.metadata?.nodeNumber;
    if (!nodeNumber || loadedMeshesRef.current[nodeNumber]) {
      return loadedMeshesRef.current[nodeNumber];
    }

    try {
      const db = await initDB();

      // Check cache first
      if (meshCacheRef.current.has(nodeNumber)) {
        const cachedMeshes = meshCacheRef.current.get(nodeNumber);
        loadedMeshesRef.current[nodeNumber] = cachedMeshes;
        setLoadedOriginalMeshes((prev) => ({
          ...prev,
          [nodeNumber]: cachedMeshes,
        }));
        return cachedMeshes;
      }
      const mergedStore = db
        .transaction("mergedlowPoly", "readonly")
        .objectStore("mergedlowPoly");
      const mergedData = await mergedStore.get(`merged_node_${nodeNumber}`);

      if (!mergedData?.metadata?.originalMeshKeys?.length) {
        console.warn(`No original mesh keys found for node ${nodeNumber}`);
        return null;
      }

      const originalStore = db
        .transaction("originalMeshes", "readonly")
        .objectStore("originalMeshes");
      const originalMeshes = [];

      // Modified mesh creation with optimization flags
      for (const meshKey of mergedData.metadata.originalMeshKeys) {
        try {
          const meshData = await originalStore.get(meshKey.meshId);
          if (!meshData?.data) continue;

          // Create mesh
          const mesh = new BABYLON.Mesh(meshKey.fileName, sceneRef.current);

          // Apply vertex data
          const vertexData = new BABYLON.VertexData();
          if (meshData.data) {
            if (meshData.data.positions) {
              vertexData.positions = new Float32Array(meshData.data.positions);
            }
            if (meshData.data.indices) {
              vertexData.indices = new Uint32Array(meshData.data.indices);
            }
            if (meshData.data.normals) {
              vertexData.normals = new Float32Array(meshData.data.normals);
            }

            vertexData.applyToMesh(mesh);
          } else {
            console.warn(`No data found for mesh ${meshKey.meshId}`);
            continue;
          }

          // Apply transforms from original mesh data
          if (meshData.data.transforms) {
            if (meshData.data.transforms.worldMatrix) {
              const localMatrix = BABYLON.Matrix.FromArray(
                meshData.data.transforms.worldMatrix
              );
              mesh.setPreTransformMatrix(localMatrix);
            } else {
              const position = meshData.data.transforms.position || {
                x: 0,
                y: 0,
                z: 0,
              };
              const rotation = meshData.data.transforms.rotation || {
                x: 0,
                y: 0,
                z: 0,
              };
              const scaling = meshData.data.transforms.scaling || {
                x: 1,
                y: 1,
                z: 1,
              };

              mesh.position = new BABYLON.Vector3(
                position.x,
                position.y,
                position.z
              );
              mesh.rotation = new BABYLON.Vector3(
                rotation.x,
                rotation.y,
                rotation.z
              );
              mesh.scaling = new BABYLON.Vector3(
                scaling.x,
                scaling.y,
                scaling.z
              );
            }
          }

          // Create and apply material
          const material = new BABYLON.StandardMaterial(
            `original_material_${meshKey.meshId}`,
            sceneRef.current
          );

          // Set material properties
          const meshColor = new BABYLON.Color3(1, 0, 0); // Red color for visibility testing
          material.diffuseColor = meshColor;
          material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
          material.backFaceCulling = false;
          material.twoSidedLighting = true;
          mesh.material = material;

          // Set mesh properties
          mesh.isPickable = true;
          mesh.isVisible = true; // Make visible initially for debugging

          // Store metadata
          mesh.metadata = {
            isOriginalMesh: true,
            nodeNumber: nodeNumber,
            meshId: meshKey.meshId,
            originalName: meshKey.fileName,
            boundingbox: meshData.data.boundingBox,
          };

          originalMeshes.push(mesh);
        } catch (error) {
          console.error(
            `Error creating original mesh ${meshKey.fileName}:`,
            error
          );
        }
      }

      if (originalMeshes.length > 0) {
        // Update both ref and state
        loadedMeshesRef.current[nodeNumber] = originalMeshes;
        meshCacheRef.current.set(nodeNumber, originalMeshes);
        setLoadedOriginalMeshes((prev) => ({
          ...prev,
          [nodeNumber]: originalMeshes,
        }));

        // Add disposal tracking for each mesh
        originalMeshes.forEach((mesh) => {
          trackMeshDisposal(nodeNumber, mesh);
        });

        return originalMeshes;
      }

      return null;
    } catch (error) {
      console.error(
        `Error loading original meshes for node ${nodeNumber}:`,
        error
      );
      return null;
    }
  };

  // New function to handle node cleanup
  const cleanupNodeMeshes = async (nodeNumber) => {
    if (!loadedMeshesRef.current[nodeNumber] || !sceneRef.current) {
      console.log(
        `No meshes found for node ${nodeNumber} or scene not initialized`
      );
      return;
    }

    const meshesToClean = [...loadedMeshesRef.current[nodeNumber]];
    let cleanupSuccessful = true;

    for (const mesh of meshesToClean) {
      try {
        if (mesh && !mesh.isDisposed()) {
          // Pass the scene reference explicitly
          await cleanupMesh(mesh, sceneRef.current);
        }
      } catch (error) {
        console.error(`Error cleaning up mesh in node ${nodeNumber}:`, error);
        cleanupSuccessful = false;
      }
    }

    if (cleanupSuccessful) {
      // Clear references only if cleanup was successful
      delete loadedMeshesRef.current[nodeNumber];
      meshCacheRef.current.delete(nodeNumber);
      setLoadedOriginalMeshes((prev) => {
        const newState = { ...prev };
        delete newState[nodeNumber];
        return newState;
      });
    }
  };

  // Add this utility function for frustum checking
  const isInFrustum = (mesh, camera) => {
    if (!mesh || mesh.isDisposed()) return false;

    // Get the mesh's bounding info
    const boundingBox = mesh.getBoundingInfo().boundingBox;

    // Check if the mesh's bounding box intersects with the camera's frustum
    return camera.isInFrustum(boundingBox);
  };

  // Modified updateMeshVisibility to include frustum culling and culling stats and loading original meshes
  // ------------------------------
  // const updateMeshVisibility = async () => {
  //   // Initialize culling counters
  //   let totalMeshes = 0;
  //   let culledMeshes = 0;
  //   if (!sceneRef.current?.activeCamera || isUpdatingRef.current) return;

  //   try {
  //     isUpdatingRef.current = true;
  //     const camera = sceneRef.current.activeCamera;
  //     const distance = distanceThreshold;
  //     const processedNodes = new Set();

  //     // First pass - identify meshes that need cleanup
  //     const nodesToCleanup = new Set();
  //     for (const mergedMesh of sceneRef.current.meshes) {
  //       if (
  //         !mergedMesh.metadata?.nodeNumber ||
  //         mergedMesh.metadata.isOriginalMesh
  //       )
  //         continue;

  //       const meshDistance = getDistanceToCamera(mergedMesh, camera);
  //       const nodeNumber = mergedMesh.metadata.nodeNumber;
  //       processedNodes.add(nodeNumber);

  //       // Check both distance and frustum conditions
  //       if (
  //         (meshDistance > distance || !isInFrustum(mergedMesh, camera)) &&
  //         loadedMeshesRef.current[nodeNumber]
  //       ) {
  //         nodesToCleanup.add(nodeNumber);
  //       }
  //     }

  //     // Handle cleanups first
  //     if (nodesToCleanup.size > 0) {
  //       const cleanupPromises = Array.from(nodesToCleanup).map(
  //         async (nodeNumber) => {
  //           try {
  //             const meshesToClean = loadedMeshesRef.current[nodeNumber];
  //             if (!meshesToClean) return;

  //             // Remove references first
  //             delete loadedMeshesRef.current[nodeNumber];
  //             meshCacheRef.current.delete(nodeNumber);

  //             // Then dispose meshes
  //             for (const mesh of meshesToClean) {
  //               if (mesh && !mesh.isDisposed()) {
  //                 await cleanupMesh(mesh,sceneRef.current);
  //                 // Double check the mesh was actually disposed
  //                 if (!mesh.isDisposed()) {
  //                   mesh.dispose(false, true);
  //                 }
  //               }
  //             }

  //             setLoadedOriginalMeshes((prev) => {
  //               const newState = { ...prev };
  //               delete newState[nodeNumber];
  //               return newState;
  //             });
  //           } catch (error) {
  //             console.error(`Error cleaning up node ${nodeNumber}:`, error);
  //           }
  //         }
  //       );

  //       await Promise.all(cleanupPromises);
  //     }

  //     // Then handle loading new meshes with frustum checking
  //     for (const mergedMesh of sceneRef.current.meshes) {
  //       if (
  //         !mergedMesh.metadata?.nodeNumber ||
  //         mergedMesh.metadata.isOriginalMesh
  //       )
  //         continue;

  //       const meshDistance = getDistanceToCamera(mergedMesh, camera);
  //       const nodeNumber = mergedMesh.metadata.nodeNumber;
  //       const isVisible =
  //         meshDistance <= distance && isInFrustum(mergedMesh, camera);

  //       if (isVisible) {
  //         mergedMesh.isVisible = false;
  //         if (
  //           !loadedMeshesRef.current[nodeNumber] &&
  //           !nodesToCleanup.has(nodeNumber)
  //         ) {

  //           const loadedMeshes = await loadOriginalMeshes(mergedMesh);
  //           if (loadedMeshes) {
  //             console.log(loadedMeshes)
  //             // Add frustum culling checks for newly loaded meshes
  //             loadedMeshes.forEach((mesh) => {
  //               mesh.alwaysSelectAsActiveMesh = true; // Ensure frustum checks are always performed
  //               mesh.isPickable = isInFrustum(mesh, camera); // Only pickable if in frustum
  //             });
  //             loadedMeshesRef.current[nodeNumber] = loadedMeshes;
  //           }
  //         }
  //       } else {
  //         mergedMesh.isVisible = true;
  //       }
  //     }

  //     // Additional frustum-based cleanup for original meshes
  //     for (const nodeNumber in loadedMeshesRef.current) {
  //       const meshes = loadedMeshesRef.current[nodeNumber];
  //       if (!meshes) continue;

  //       const allOutsideFrustum = meshes.every(
  //         (mesh) => !isInFrustum(mesh, camera)
  //       );
  //       if (allOutsideFrustum) {
  //         await cleanupNodeMeshes(Number(nodeNumber));
  //       }
  //     }

  //     // Final cleanup of any orphaned nodes
  //     const currentNodes = Object.keys(loadedMeshesRef.current).map(Number);
  //     for (const nodeNumber of currentNodes) {
  //       if (!processedNodes.has(nodeNumber)) {
  //         await cleanupNodeMeshes(nodeNumber);
  //       }
  //     }

  //     // Count total and culled meshes
  //     sceneRef.current.meshes.forEach((mesh) => {
  //       if (mesh.metadata?.nodeNumber) {
  //         totalMeshes++;
  //         if (!isInFrustum(mesh, camera)) {
  //           culledMeshes++;
  //         }
  //       }
  //     });

  //     // Update culling statistics
  //     setCulledMeshes({
  //       total: totalMeshes,
  //       culled: culledMeshes,
  //     });
  //   } finally {
  //     isUpdatingRef.current = false;
  //   }
  // };

  const updateMeshVisibility = async () => {
    if (!sceneRef.current?.activeCamera || isUpdatingRef.current) return;

    try {
      isUpdatingRef.current = true;
      const camera = sceneRef.current.activeCamera;
      const distance = distanceThreshold;
      let totalMeshes = 0;
      let culledMeshes = 0;

      // Get all merged meshes
      const mergedMeshes = sceneRef.current.meshes.filter(
        (mesh) => mesh.metadata?.nodeNumber && !mesh.metadata.isOriginalMesh
      );

      // Track which nodes are in view
      const visibleNodes = new Set();
      const nodesToDispose = new Set();

      // First pass - identify meshes visibility state
      for (const mergedMesh of mergedMeshes) {
        const nodeNumber = mergedMesh.metadata.nodeNumber;
        const meshDistance = getDistanceToCamera(mergedMesh, camera);
        // const isInView = meshDistance >= distance && isInFrustum(mergedMesh, camera);

        const isInView = isInFrustum(mergedMesh, camera);

        if (isInView) {
          visibleNodes.add(nodeNumber);
        } else {
          nodesToDispose.add(nodeNumber);
        }

        totalMeshes++;
        if (!isInView) {
          culledMeshes++;
        }
      }

      // Handle disposal of out-of-view meshes
      for (const nodeNumber of nodesToDispose) {
        const meshToDispose = mergedMeshes.find(
          (mesh) => mesh.metadata.nodeNumber === nodeNumber
        );
        if (meshToDispose && !meshToDispose.isDisposed()) {
          meshToDispose.setEnabled(false); // Disable instead of full disposal for better performance
          meshToDispose.isVisible = false;
        }
      }

      // Handle loading of in-view meshes
      const loadPromises = Array.from(visibleNodes).map(async (nodeNumber) => {
        const existingMesh = mergedMeshes.find(
          (mesh) => mesh.metadata.nodeNumber === nodeNumber
        );

        if (existingMesh) {
          if (!existingMesh.isEnabled()) {
            existingMesh.setEnabled(true);
          }
          existingMesh.isVisible = true;
        } else {
          // Load the merged mesh if it's not in the scene
          try {
            const db = await initDB();
            const store = db
              .transaction("mergedlowPoly", "readonly")
              .objectStore("mergedlowPoly");

            const meshData = await store.get(`merged_node_${nodeNumber}`);
            if (meshData) {
              // Create and add the mesh to the scene
              const newMesh = createMergedMesh(meshData, sceneRef.current);
              if (newMesh) {
                newMesh.setEnabled(true);
                newMesh.isVisible = true;
              }
            }
          } catch (error) {
            console.error(
              `Error loading merged mesh for node ${nodeNumber}:`,
              error
            );
          }
        }
      });

      await Promise.all(loadPromises);

      // Update statistics
      setCulledMeshes({
        total: totalMeshes,
        culled: culledMeshes,
      });
    } finally {
      isUpdatingRef.current = false;
    }
  };

  // const updateMeshVisibility = async () => {
  //   if (!sceneRef.current?.activeCamera || isUpdatingRef.current) return;

  //   try {
  //     isUpdatingRef.current = true;
  //     const camera = sceneRef.current.activeCamera;
  //     const engine = engineRef.current;
  //     const distance = distanceThreshold;
  //     let totalMeshes = 0;
  //     let culledMeshes = 0;

  //     // Get all merged meshes
  //     const mergedMeshes = sceneRef.current.meshes.filter(
  //       mesh => mesh.metadata?.nodeNumber && !mesh.metadata.isOriginalMesh
  //     );

  //     // Track which nodes are in view
  //     const visibleNodes = new Set();
  //     const nodesToDispose = new Set();

  //     // Calculate coverage for all meshes first
  //     const meshCoverages = new Map();
  //     mergedMeshes.forEach(mesh => {
  //       if (mesh.metadata?.isSkippedMesh) {
  //         const coverage = calculateMeshScreenCoverage(mesh, camera, engine);
  //         meshCoverages.set(mesh.id, coverage);
  //       }
  //     });

  //     // First pass - identify meshes visibility state
  //     for (const mergedMesh of mergedMeshes) {
  //       const nodeNumber = mergedMesh.metadata.nodeNumber;
  //       const meshDistance = getDistanceToCamera(mergedMesh, camera);
  //       const coverage = meshCoverages.get(mergedMesh.id) || 0;

  //       // Combine frustum check with coverage check
  //       const isInView = isInFrustum(mergedMesh, camera) &&
  //                       (mergedMesh.metadata?.isSkippedMesh ? coverage >= 0.0002 : true);

  //       if (isInView) {
  //         visibleNodes.add(nodeNumber);
  //       } else {
  //         nodesToDispose.add(nodeNumber);
  //       }

  //       totalMeshes++;
  //       if (!isInView) {
  //         culledMeshes++;
  //       }

  //       // Store original material if not already stored
  //       if (mergedMesh.metadata?.isSkippedMesh && !meshMaterialsMap.has(mergedMesh.id)) {
  //         meshMaterialsMap.set(mergedMesh.id, mergedMesh.material);
  //       }
  //     }

  //     // Handle disposal of out-of-view meshes
  //     for (const nodeNumber of nodesToDispose) {
  //       const meshToDispose = mergedMeshes.find(
  //         mesh => mesh.metadata.nodeNumber === nodeNumber
  //       );
  //       if (meshToDispose && !meshToDispose.isDisposed()) {
  //         if (meshToDispose.metadata?.isSkippedMesh) {
  //           meshToDispose.setEnabled(false);
  //           meshToDispose.isVisible = false;
  //           meshToDispose.isPickable = false;
  //           meshToDispose.visibility = 0;
  //         } else {
  //           meshToDispose.setEnabled(false);
  //           meshToDispose.isVisible = false;
  //         }
  //         meshToDispose.computeWorldMatrix(true);
  //       }
  //     }

  //     // Handle loading of in-view meshes
  //     const loadPromises = Array.from(visibleNodes).map(async nodeNumber => {
  //       const existingMesh = mergedMeshes.find(
  //         mesh => mesh.metadata.nodeNumber === nodeNumber
  //       );

  //       if (existingMesh) {
  //         if (!existingMesh.isEnabled()) {
  //           existingMesh.setEnabled(true);
  //         }
  //         existingMesh.isVisible = true;
  //         existingMesh.isPickable = true;
  //         existingMesh.visibility = 1;

  //         // Restore original material for skipped meshes
  //         if (existingMesh.metadata?.isSkippedMesh) {
  //           const originalMaterial = meshMaterialsMap.get(existingMesh.id);
  //           if (originalMaterial) {
  //             existingMesh.material = originalMaterial;
  //           }
  //         }
  //         existingMesh.computeWorldMatrix(true);
  //       } else {
  //         // Load the merged mesh if it's not in the scene
  //         try {
  //           const db = await initDB();
  //           const store = db
  //             .transaction("mergedlowPoly", "readonly")
  //             .objectStore("mergedlowPoly");

  //           const meshData = await store.get(`merged_node_${nodeNumber}`);
  //           if (meshData) {
  //             const newMesh = createMergedMesh(meshData, sceneRef.current);
  //             if (newMesh) {
  //               newMesh.setEnabled(true);
  //               newMesh.isVisible = true;
  //               newMesh.isPickable = true;
  //               newMesh.visibility = 1;
  //             }
  //           }
  //         } catch (error) {
  //           console.error(`Error loading merged mesh for node ${nodeNumber}:`, error);
  //         }
  //       }
  //     });

  //     await Promise.all(loadPromises);

  //     // Update statistics
  //     setCulledMeshes({
  //       total: totalMeshes,
  //       culled: culledMeshes
  //     });

  //     // Force scene update
  //     sceneRef.current.render();

  //   } finally {
  //     isUpdatingRef.current = false;
  //   }
  // };

  // Helper function to create merged mesh from data
  
  
  const createMergedMesh = (meshData, scene) => {
    try {
      const mesh = new BABYLON.Mesh(
        `merged_node_${meshData.metadata.nodeNumber}`,
        scene
      );

      // Apply vertex data
      const vertexData = new BABYLON.VertexData();
      vertexData.positions = new Float32Array(meshData.vertexData.positions);
      vertexData.indices = new Uint32Array(meshData.vertexData.indices);
      if (meshData.vertexData.normals) {
        vertexData.normals = new Float32Array(meshData.vertexData.normals);
      }
      vertexData.applyToMesh(mesh);

      // Apply transforms
      if (meshData.transforms) {
        if (meshData.transforms.worldMatrix) {
          mesh.setPreTransformMatrix(
            BABYLON.Matrix.FromArray(meshData.transforms.worldMatrix)
          );
        } else {
          mesh.position = new BABYLON.Vector3(
            meshData.transforms.position.x,
            meshData.transforms.position.y,
            meshData.transforms.position.z
          );
          mesh.rotation = new BABYLON.Vector3(
            meshData.transforms.rotation.x,
            meshData.transforms.rotation.y,
            meshData.transforms.rotation.z
          );
          mesh.scaling = new BABYLON.Vector3(
            meshData.transforms.scaling.x,
            meshData.transforms.scaling.y,
            meshData.transforms.scaling.z
          );
        }
      }

      // Set up material
      const material = new BABYLON.StandardMaterial(
        `material_${meshData.metadata.nodeNumber}`,
        scene
      );
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      mesh.material = material;

      // Set metadata
      mesh.metadata = meshData.metadata;

      return mesh;
    } catch (error) {
      console.error("Error creating merged mesh:", error);
      return null;
    }
  };

  // Modified trackMeshDisposal to include frustum tracking
  const trackMeshDisposal = (nodeNumber, mesh) => {
    if (!mesh) return;

    // Add frustum check observer
    mesh.onBeforeRenderObservable.add(() => {
      if (!isInFrustum(mesh, sceneRef.current.activeCamera)) {
        mesh.isPickable = false;
      } else {
        mesh.isPickable = true;
      }
    });

    mesh.onDisposeObservable.add(() => {
      // Update tracking in both ref and state
      if (loadedMeshesRef.current[nodeNumber]) {
        loadedMeshesRef.current[nodeNumber] = loadedMeshesRef.current[
          nodeNumber
        ].filter((m) => m.id !== mesh.id);
        if (loadedMeshesRef.current[nodeNumber].length === 0) {
          delete loadedMeshesRef.current[nodeNumber];
        }
      }

      setDisposedMeshes((prev) => new Set([...prev, mesh.id]));
    });
  };

  // Enhanced logMeshStates to include frustum information
  const logMeshStates = () => {
    const meshStates = {};
    const camera = sceneRef.current.activeCamera;

    sceneRef.current.meshes.forEach((mesh) => {
      if (mesh.metadata?.nodeNumber) {
        if (!meshStates[mesh.metadata.nodeNumber]) {
          meshStates[mesh.metadata.nodeNumber] = {
            total: 0,
            original: 0,
            merged: 0,
            disposed: 0,
            inFrustum: 0,
          };
        }
        meshStates[mesh.metadata.nodeNumber].total++;
        if (mesh.metadata.isOriginalMesh) {
          meshStates[mesh.metadata.nodeNumber].original++;
        } else {
          meshStates[mesh.metadata.nodeNumber].merged++;
        }
        if (mesh.isDisposed()) {
          meshStates[mesh.metadata.nodeNumber].disposed++;
        }
        if (isInFrustum(mesh, camera)) {
          meshStates[mesh.metadata.nodeNumber].inFrustum++;
        }
      }
    });
    // Calculate total culling statistics
    let totalMeshCount = 0;
    let totalCulledCount = 0;
    Object.values(meshStates).forEach((state) => {
      totalMeshCount += state.total;
      totalCulledCount += state.total - state.inFrustum;
    });
  };

  // Call this periodically or after major operations
  useEffect(() => {
    const interval = setInterval(logMeshStates, 5000);
    return () => clearInterval(interval);
  }, []);

  // Add to updateMeshVisibility function
  const getNearestNodes = (camera, meshes) => {
    const nearNodes = new Set();

    meshes.forEach((mesh) => {
      if (!mesh.metadata?.nodeNumber) return;

      const distance = getDistanceToCamera(mesh, camera);
      if (distance <=  distanceThresholdRef.current) {
        nearNodes.add(mesh.metadata.nodeNumber);
      }
    });

    return Array.from(nearNodes);
  };

  return (
    <div
      className="p-4"
      style={{ zIndex: "1", position: "absolute", width: "100%" }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100vh",
          position: "absolute",
          overflow: "hidden",
          zIndex: "0",
        }}
      />

      <div
        style={{ position: "absolute", zIndex: "1000", right: "0%", top: "0" }}
      >
        <button
          onClick={loadMergedPolyMeshes}
          disabled={isLoadingLpoly}
          className="btn btn-warning"
        >
          {isLoadingLpoly ? "Loading merged Models..." : "Load merged Models"}
        </button>
        <button
          onClick={loadSkippedMergedPolyMeshes}
          disabled={isLoadingLpoly || isLoadingSkipped}
          className="btn btn-danger"
        >
          {isLoadingSkipped
            ? "Loading skipped Models..."
            : "Load skipped Models"}
        </button>
        <button
          onClick={() => toggleCamera("arcRotate")}
          className={`btn ${
            cameraType === "arcRotate" ? "btn-primary" : "btn-secondary"
          }`}
        >
          Orbit Camera
        </button>
        <button
          onClick={() => toggleCamera("fly")}
          className={`btn ${
            cameraType === "fly" ? "btn-primary" : "btn-secondary"
          }`}
        >
          Fly Camera
        </button>
        <PerformanceMonitor
          fps={fps}
          memory={memory}
          culledMeshes={culledMeshes}
        />{" "}
        {status && <div className="mt-2 text-sm text-gray-600">{status}</div>}
        {isLoadingLpoly && (
          <div className="mt-4">
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 animate-pulse"
                style={{ width: "100%" }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ModelLoader;
