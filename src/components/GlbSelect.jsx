import React, { useCallback, useState, useEffect, useRef } from "react";
import * as BABYLON from "@babylonjs/core";
import "@babylonjs/loaders";
import { calculateScreenCoverage } from "../utils/CalculateScreenCoverage";
import { loadModels } from "../utils/LoadModels";
import { createOctreeBlock } from "../utils/CreateOctreeBlock";
import { distributeMeshesToOctree } from "../utils/CreateOctreeBlock";
import { createOctreeInfo } from "../utils/CreateOctreeBlock";

// Worker pool configuration
const NUM_WORKERS = navigator.hardwareConcurrency || 4;
const BATCH_SIZE = 5;

function GlbSelect() {
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const engineRef = useRef(null);
  const sceneRef = useRef(null);
  const canvasRef = useRef(null);
  const workersRef = useRef([]);
  const workerQueueRef = useRef([]);
  let meshIdCounter = 1;

  const [processProgress, setProcessProgress] = useState({
    stage: "",
    current: 0,
    total: 0,
    subStage: "",
    subProgress: 0,
    processingStage: 0, // 0: Not started, 1: Files, 2: Octree, 3: Models, 4: Complete
  });
  // First update the variable initialization to match Fbxload.js
  const MAX_DEPTH = 4;

  // Update the tracking variables to match Fbxload.js structure
  let nodesAtDepth = new Array(MAX_DEPTH + 1).fill(0);
  let nodeNumbersByDepth = Array.from({ length: MAX_DEPTH + 1 }, () => []);
  let nodesAtDepthWithBoxes = new Array(MAX_DEPTH + 1).fill(0);
  let boxesAtDepth = Array.from({ length: MAX_DEPTH + 1 }, () => new Set());
  let nodeContents = new Map();
  let nodeDepths = new Map();
  let nodeParents = new Map();
  let nodeCounter = 1;

  // Initialize IndexedDB
  const initDB = async () => {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("huldrascreencoverage0.3", 1);   //MeshStorage Pipingdepth8 TestingStorage Piping  huldra15degree

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create stores if they don't exist
        if (!db.objectStoreNames.contains('octree')) {
          db.createObjectStore('octree');
      }
      if (!db.objectStoreNames.contains('lowPolyMeshes')) {
          db.createObjectStore('lowPolyMeshes');
      }
      if (!db.objectStoreNames.contains('originalMeshes')) {
          db.createObjectStore('originalMeshes');
      }
      if (!db.objectStoreNames.contains('mergedlowPoly')) {
          db.createObjectStore('mergedlowPoly');
      }
      if (!db.objectStoreNames.contains('mergedSkippedMeshes')) {
          db.createObjectStore('mergedSkippedMeshes');
      }
      };
    });
  };

  // Store data in IndexedDB
  const storeInDB = async (storeName, key, data) => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.put(data, key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.style.display = "none"; // Keep this if you don't want to show the canvas
    document.body.appendChild(canvas);
    canvasRef.current = canvas;

    const engine = new BABYLON.Engine(canvas, true);
    engineRef.current = engine;

    const scene = new BABYLON.Scene(engine);
    sceneRef.current = scene;

    // Initialize camera properly
    const camera = new BABYLON.ArcRotateCamera(
      "camera",
      0,
      Math.PI / 3,
      10,
      BABYLON.Vector3.Zero(),
      scene
    );
    camera.attachControl(canvas, true);

    // Set initial camera properties
    camera.radius = 100; // Set a default radius
    camera.alpha = Math.PI / 4;
    camera.beta = Math.PI / 3;
    camera.wheelPrecision = 50;
    camera.minZ = 0.1;
    camera.maxZ = 1000;

    // Store camera reference in scene for easy access
    scene.activeCamera = camera;

    // Add basic light
    const light = new BABYLON.HemisphericLight(
      "light",
      new BABYLON.Vector3(0, 1, 0),
      scene
    );

    engine.runRenderLoop(() => {
      scene.render();
    });

    window.addEventListener("resize", () => {
      engine.resize();
    });

    return () => {
      engine.dispose();
      scene.dispose();
      canvas.remove();
      if (scene) {
        scene.meshes.slice().forEach((mesh) => mesh.dispose());
        scene.materials.slice().forEach((material) => material.dispose());
        scene.textures.slice().forEach((texture) => texture.dispose());
      }
    };
  }, []);

  const loadFile = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          const scene = sceneRef.current;
          const data = event.target.result;

          const result = await BABYLON.SceneLoader.LoadAssetContainerAsync(
            "file:",
            file,
            scene,
            null,
            ".glb"
          );

          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  // Initialize workers
  // Update the worker message handler in useEffect
  useEffect(() => {
    workersRef.current = Array(NUM_WORKERS)
      .fill(null)
      .map(() => {
        const worker = new Worker(new URL("./meshWorker.js", import.meta.url));
        worker.busy = false;
        return worker;
      });

    workersRef.current.forEach((worker) => {
      worker.onmessage = async (e) => {
        try {
          const { type, meshId, originalMeshId, data, error, skipped } = e.data;

          if (type === "success") {
            // Safely handle the data structure
            const dataToStore = {
              fileName: meshId,
              data: {
                fileName: meshId,
                positions: data.data.positions,
                normals: data.data.normals,
                indices: data.data.indices,
                boundingBox: data.data.boundingBox,
                name: data.data.name,
                metadata: {
                  id: meshId,
                  originalMeshId,
                  ...(data.data.metadata || {}), // Safely spread any existing metadata
                },
                transforms: data.data.transforms || {},
              },
            };

            await storeInDB("lowPolyMeshes", meshId, dataToStore);
            setProgress((prev) => ({ ...prev, current: prev.current + 1 }));
          } else {
            console.error(`Error processing mesh ${meshId}:`, error);
          }
        } catch (processError) {
          console.error("Error in worker message processing:", processError);
          console.log("Data received:", e.data); // Log the received data for debugging
        } finally {
          worker.busy = false;
          if (workerQueueRef.current.length > 0) {
            const nextTask = workerQueueRef.current.shift();
            worker.busy = true;
            worker.postMessage(nextTask);
          }
        }
      };
    });

    return () => {
      workersRef.current.forEach((worker) => worker.terminate());
    };
  }, []);

  // Modify the processFile function to use the correct ID format
  const processFile = async (file, octreeRoot) => {
    const container = await loadFile(file);
    const tasks = [];
    let allMeshInfos = [];
 // Use sanitized filename as the file ID
 const fileId = file.name.replace(/[^a-zA-Z0-9]/g, '_');
    try {
      for (const mesh of container.meshes) {
        if (!mesh.geometry) continue;

        // Generate IDs with correct format
        const paddedNumber = meshIdCounter.toString().padStart(7, "0");
        const originalMeshId = `ori${paddedNumber}`;
        const lowPolyMeshId = `lpolyori${paddedNumber}`;
        meshIdCounter++;

        // Calculate screen coverage for this mesh
        const screenCoverage = calculateScreenCoverage(
          mesh,
          sceneRef.current.activeCamera,
          engineRef.current
        );

        // Create mesh info for octree using original ID
        const meshInfo = {
          metadata: { id: originalMeshId,fileId: fileId, screenCoverage: screenCoverage },
          boundingInfo: mesh.getBoundingInfo(),
          transforms: {
            worldMatrix: mesh.getWorldMatrix().toArray(),
          },
        };

        allMeshInfos.push(meshInfo);

        // Store original mesh data with original ID and correct structure
        const originalMeshData = {
          fileName: originalMeshId,
          data: {
            fileName: originalMeshId,
            positions: Array.from(
              mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind)
            ),
            normals: Array.from(
              mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind)
            ),
            indices: Array.from(mesh.getIndices()),
            boundingBox: mesh.getBoundingInfo().boundingBox,
            name: mesh.name,
            metadata: {
              id: originalMeshId,
              fileId: fileId,
              screenCoverage: screenCoverage,
              geometryInfo: {
                totalVertices: mesh.getTotalVertices(),
                totalIndices: mesh.getTotalIndices(),
                faceCount: mesh.getTotalIndices() / 3,
              },
            },
            transforms: {
              position: mesh.position.asArray(),
              rotation: mesh.rotation.asArray(),
              scaling: mesh.scaling.asArray(),
              worldMatrix: mesh.getWorldMatrix().toArray(),
            },
          },
        };

        await storeInDB("originalMeshes", originalMeshId, originalMeshData);

        // Create task for worker with both IDs

        tasks.push({
          meshData: originalMeshData.data, // Pass the data portion
          meshId: lowPolyMeshId,
          originalMeshId: originalMeshId,
         
        });
        // tasks.push({
        //   meshData: originalMeshData.data, // Pass the data portion
        //   meshId: lowPolyMeshId,
        //   originalMeshId: originalMeshId,
        //   angleThreshold: 20,
        // });
      }

      // Process tasks with workers
      tasks.forEach((task) => {
        const availableWorker = workersRef.current.find((w) => !w.busy);
        if (availableWorker) {
          availableWorker.busy = true;
          availableWorker.postMessage(task);
        } else {
          workerQueueRef.current.push(task);
        }
      });

      if (octreeRoot && allMeshInfos.length > 0) {
        distributeMeshesToOctree(octreeRoot, allMeshInfos);
      }
    } finally {
      container.dispose();
    }

    return allMeshInfos;
  };

  const calculateBoundingBox = useCallback((meshes) => {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let hasValidMesh = false;

    meshes.forEach((mesh) => {
      if (
        !mesh.getBoundingInfo ||
        !mesh.subMeshes ||
        mesh.subMeshes.length === 0
      )
        return;

      hasValidMesh = true;
      const boundingInfo = mesh.getBoundingInfo();

      // Use world coordinates directly
      const worldMin = boundingInfo.boundingBox.minimumWorld;
      const worldMax = boundingInfo.boundingBox.maximumWorld;

      // Update global min and max values
      minX = Math.min(minX, worldMin.x);
      minY = Math.min(minY, worldMin.y);
      minZ = Math.min(minZ, worldMin.z);
      maxX = Math.max(maxX, worldMax.x);
      maxY = Math.max(maxY, worldMax.y);
      maxZ = Math.max(maxZ, worldMax.z);
    });

    if (!hasValidMesh) {
      return {
        min: new BABYLON.Vector3(0, 0, 0),
        max: new BABYLON.Vector3(0, 0, 0),
        center: new BABYLON.Vector3(0, 0, 0),
        extent: { width: 0, height: 0, depth: 0 },
      };
    }

    // Create vectors for the results
    const minVector = new BABYLON.Vector3(minX, minY, minZ);
    const maxVector = new BABYLON.Vector3(maxX, maxY, maxZ);
    const centerVector = BABYLON.Vector3.Center(minVector, maxVector);

    return {
      min: minVector,
      max: maxVector,
      center: centerVector,
      extent: {
        width: maxX - minX,
        height: maxY - minY,
        depth: maxZ - minZ,
      },
    };
  }, []);

  // Add this function to calculate overall progress
  const calculateOverallProgress = () => {
    const { processingStage, current, total } = processProgress;
    const stageWeight = 25; // Each stage is worth 25% of total progress
    const baseProgress = processingStage * stageWeight;

    if (total === 0) return baseProgress;
    const stageProgress = (current / total) * stageWeight;
    return Math.min(baseProgress + stageProgress, 100);
  };

  // Function to update progress
  const updateProgress = (updates) => {
    setProcessProgress((prev) => ({
      ...prev,
      ...updates,
    }));
  };

  
  const handleFileChange = useCallback(async (event) => {
    // Reset tracking structures
    nodesAtDepth = new Array(MAX_DEPTH + 1).fill(0);
    nodesAtDepthWithBoxes = new Array(MAX_DEPTH + 1).fill(0);
    boxesAtDepth = Array.from({ length: MAX_DEPTH + 1 }, () => new Set());
    nodeNumbersByDepth = Array.from({ length: MAX_DEPTH + 1 }, () => []);
    nodeContents = new Map();
    nodeDepths = new Map();
    nodeParents = new Map();
    nodeCounter = 1;

    const selectedFiles = Array.from(event.target.files);
    setFiles(selectedFiles);
    updateProgress({
      stage: "Processing Files",
      current: 0,
      total: selectedFiles.length,
      processingStage: 1,
      subStage: "Initializing",
    });

    try {
      let allMeshInfos = [];

      // Process files in batches
      for (let i = 0; i < selectedFiles.length; i += BATCH_SIZE) {
        const batch = selectedFiles.slice(i, i + BATCH_SIZE);
        updateProgress({
          current: i,
          subStage: `Batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(
            selectedFiles.length / BATCH_SIZE
          )}`,
        });

        const batchPromises = batch.map((file) => processFile(file, null));
        const batchMeshInfos = await Promise.all(batchPromises);
        allMeshInfos = allMeshInfos.concat(batchMeshInfos.flat());

        updateProgress({
          current: i + batch.length,
          subProgress: ((i + batch.length) / selectedFiles.length) * 100,
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Update to Octree creation stage
      updateProgress({
        stage: "Creating Octree",
        processingStage: 2,
        subStage: "Calculating bounds",
      });

      const boundingBoxPromises = selectedFiles.map(async (file, index) => {
        const container = await loadFile(file);
        const boundingBox = calculateBoundingBox(container.meshes);
        container.dispose();

        updateProgress({
          current: index + 1,
          total: selectedFiles.length,
          subProgress: ((index + 1) / selectedFiles.length) * 100,
        });

        return boundingBox;
      });

      const boundingBoxes = await Promise.all(boundingBoxPromises);

      // Create cumulative bounds and octree
      updateProgress({
        subStage: "Building octree structure",
        subProgress: 50,
      });

      const cumulativeMin = boundingBoxes.reduce(
        (min, box) => BABYLON.Vector3.Minimize(min, box.min),
        new BABYLON.Vector3(Infinity, Infinity, Infinity)
      );

      const cumulativeMax = boundingBoxes.reduce(
        (max, box) => BABYLON.Vector3.Maximize(max, box.max),
        new BABYLON.Vector3(-Infinity, -Infinity, -Infinity)
      );

      const octreeRoot = createOctreeBlock(
        sceneRef.current,
        cumulativeMin,
        cumulativeMax,
        allMeshInfos,
        0,
        null
      );

      updateProgress({
        subStage: "Storing octree data",
        subProgress: 75,
      });

      const octreeInfo = createOctreeInfo(
        octreeRoot,
        cumulativeMin,
        cumulativeMax
      );
      await storeInDB("octree", "mainOctree", octreeInfo);

      // Move to model loading stage
      updateProgress({
        stage: "Loading Models",
        processingStage: 3,
        subStage: "Initializing model loading",
        subProgress: 0,
      });

      await loadModels();

      // Complete
      updateProgress({
        stage: "Complete",
        processingStage: 4,
        subStage: "Processing complete",
        subProgress: 100,
      });
    } catch (error) {
      console.error("Error processing files:", error);
      setStatus("Error processing files: " + error.message);
      updateProgress({
        stage: "Error",
        subStage: error.message,
      });
    }
  }, []);

  const progressDisplay = (
    <div className="mt-4 space-y-2">
      <div className="flex justify-between text-sm text-gray-600">
        <span>{processProgress.stage}</span>
        <span>{Math.round(calculateOverallProgress())}%</span>
      </div>

      <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
        <div
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
          style={{ width: `${calculateOverallProgress()}%` }}
        />
      </div>

      {processProgress.subStage && (
        <div className="text-sm text-gray-500">
          <div className="flex justify-between">
            <span>{processProgress.subStage}</span>
            <span>{Math.round(processProgress.subProgress)}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
            <div
              className="bg-blue-400 h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${processProgress.subProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
  return (
    <div className="p-4" style={{position:'absolute', zIndex:'1000'}}>
      <input
        type="file"
        accept=".glb"
        multiple
        onChange={handleFileChange}
        className="mb-4 block w-full text-sm text-gray-500
          file:mr-4 file:py-2 file:px-4
          file:rounded-md file:border-0
          file:text-sm file:font-semibold
          file:bg-blue-50 file:text-blue-700
          hover:file:bg-blue-100"
      />
      {status && <div className="mt-2 text-sm text-gray-600">{status}</div>}
      {processProgress.processingStage > 0 && progressDisplay}
    </div>
  );
}

export default GlbSelect;
