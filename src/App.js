import { Route, Routes } from 'react-router-dom';
import './App.css';
import GlbSelect from './components/GlbSelect';
import ModelLoader from './components/LoadFromDB';
import OptimizedGlbSelect from './components/GlbOptimised';
import DockManagementSystem from './pages/Shipyard';

function App() {
  return (
    <div >
     {/* <GlbSelect/> */}
     <OptimizedGlbSelect/>
     <ModelLoader/>
     {/* <DockManagementSystem/> */}
    </div>
  );
}

export default App;
