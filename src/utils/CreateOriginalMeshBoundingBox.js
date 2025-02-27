import * as BABYLON from "@babylonjs/core";

export const createOriginalMeshBoundingBox = (boundingBox, scene, color = new BABYLON.Color3(1, 1, 0), meshData) => {
  const worldMin = new BABYLON.Vector3(
    boundingBox.minimumWorld._x,
    boundingBox.minimumWorld._y,
    boundingBox.minimumWorld._z
  );
  
  const worldMax = new BABYLON.Vector3(
    boundingBox.maximumWorld._x,
    boundingBox.maximumWorld._y,
    boundingBox.maximumWorld._z
  );

  const size = {
    width: Math.abs(worldMax.x - worldMin.x),
    height: Math.abs(worldMax.y - worldMin.y),
    depth: Math.abs(worldMax.z - worldMin.z)
  };

  const worldCenter = new BABYLON.Vector3(
    boundingBox.centerWorld._x,
    boundingBox.centerWorld._y,
    boundingBox.centerWorld._z
  );

  const box = BABYLON.MeshBuilder.CreateBox(
    `boundingBox_${meshData.meshId}`,
    size,
    scene
  );

  box.position = worldCenter;

  // Create default material
  const defaultMaterial = new BABYLON.StandardMaterial(`defaultMat_${meshData.meshId}`, scene);
  defaultMaterial.wireframe = true;
  defaultMaterial.alpha = 0.3;
  defaultMaterial.emissiveColor = color;

  // Create highlight material
  const highlightMaterial = new BABYLON.StandardMaterial(`highlightMat_${meshData.meshId}`, scene);
  highlightMaterial.wireframe = true;
  highlightMaterial.alpha = 0.5;
  highlightMaterial.emissiveColor = new BABYLON.Color3(1, 1, 0); // Yellow highlight

  box.material = defaultMaterial;
  box.isPickable = true; // Make box pickable
  box.enableEdgesRendering();
  box.edgesWidth = 2.0;
  box.edgesColor = new BABYLON.Color4(color.r, color.g, color.b, 1);

  // Store materials and metadata
  box.defaultMaterial = defaultMaterial;
  box.highlightMaterial = highlightMaterial;
  box.metadata = {
    ...meshData,
    isOriginalBoundingBox: true,
    originalColor: color
  };

  box.renderingGroupId = 1;

  return box;
};