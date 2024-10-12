import React, { useRef, useEffect, useState } from 'react';
import * as BABYLON from '@babylonjs/core';
import '@babylonjs/loaders';

function BabylonComponent() {
  const canvasRef = useRef(null);
  const [scene, setScene] = useState(null);
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    if (canvasRef.current) {
      const engine = new BABYLON.Engine(canvasRef.current, true);
      const scene = new BABYLON.Scene(engine);
      
      const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.5, 10, BABYLON.Vector3.Zero(), scene);
      camera.attachControl(canvasRef.current, true);
      
      const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
      
      setScene(scene);
      setEngine(engine);
      
      engine.runRenderLoop(() => {
        scene.render();
      });
      
      window.addEventListener('resize', () => {
        engine.resize();
      });
    }
  }, []);

  const handleFileInput = async (event) => {
    const files = event.target.files;
    const meshes = [];
    
    for (let file of files) {
      try {
        const data = await readFileAsArrayBuffer(file);
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        
        const assetContainer = await BABYLON.SceneLoader.LoadAssetContainerAsync("", url, scene, null, ".glb");
        
        assetContainer.addAllToScene();
        meshes.push(...assetContainer.meshes);
        
        URL.revokeObjectURL(url);
      } catch (error) {
        console.error(`Error loading file ${file.name}:`, error);
      }
    }
    
    if (meshes.length > 0) {
      // Calculate cumulative bounding box
      const boundingInfo = calculateCumulativeBoundingBox(meshes);
      
      // Set camera position based on bounding box
      setCameraPosition(boundingInfo);
    }
  };

  const readFileAsArrayBuffer = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target.result);
      reader.onerror = (error) => reject(error);
      reader.readAsArrayBuffer(file);
    });
  };

  const calculateCumulativeBoundingBox = (meshes) => {
    let min = meshes[0].getBoundingInfo().boundingBox.minimumWorld;
    let max = meshes[0].getBoundingInfo().boundingBox.maximumWorld;
    
    for (let i = 1; i < meshes.length; i++) {
      const boundingInfo = meshes[i].getBoundingInfo();
      const boundingBox = boundingInfo.boundingBox;
      
      min = BABYLON.Vector3.Minimize(min, boundingBox.minimumWorld);
      max = BABYLON.Vector3.Maximize(max, boundingBox.maximumWorld);
    }
    
    return new BABYLON.BoundingInfo(min, max);
  };

  const setCameraPosition = (boundingInfo) => {
    if (scene && scene.activeCamera) {
      const camera = scene.activeCamera;
      const center = boundingInfo.boundingBox.center;
      const diagonal = boundingInfo.boundingBox.maximumWorld.subtract(boundingInfo.boundingBox.minimumWorld);
      const radius = diagonal.length() / 2;
      
      camera.setPosition(new BABYLON.Vector3(
        center.x,
        center.y,
        center.z + radius * 2
      ));
      
      camera.setTarget(center);
    }
  };

  return (
    <div>
      <input type="file" multiple onChange={handleFileInput} accept=".glb" />
      <canvas ref={canvasRef} style={{ width: '100%', height: '600px' }} />
    </div>
  );
}

export default BabylonComponent;