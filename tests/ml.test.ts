import{describe,expect,it}from"vitest";import{RandomForestTrainingService,clusterSpectralSamples,extractPostSpectralFeatures,type FeatureName,type PostSpectralSample,type TrainingSample}from"../packages/ml/src/index.js";
const names:FeatureName[]=["B04","B08","NDVI","NDMI"];const sample=(label:string,group:string,n:number):TrainingSample=>({label,spatialGroup:group,features:{B02:.1,B03:.1,B04:label==="water"?.2:.08,B08:label==="water"?.08:.6,B11:.15,B12:.12,NDVI:label==="water"?-.43:.76,NDMI:label==="water"?-.3:.6+n*.001}});
describe("Random Forest",()=>{it("trains, evaluates and serializes on spatial groups",()=>{const samples:TrainingSample[]=[];for(const label of ["water","dense_vegetation"])for(const group of ["a","b","c","d"])for(let i=0;i<15;i++)samples.push(sample(label,`${label}-${group}`,i));const result=new RandomForestTrainingService().train(samples,names,{numberOfTrees:20,seed:7});expect(result.metrics.independentTestSamples).toBeGreaterThan(0);expect(result.metrics.macroF1).toBeGreaterThan(.8);expect(result.serializedModel).toBeTruthy()})});

describe("post-spectral ML",()=>{
  it("derives water and soil indices from reflectance",()=>{
    const features=extractPostSpectralFeatures({B02:.08,B03:.1,B04:.07,B08:.6,B11:.22,B12:.18,valid:true});
    expect(features?.NDVI).toBeGreaterThan(.7);
    expect(features?.NDMI).toBeGreaterThan(.4);
    expect(features?.NDWI).toBeLessThan(0);
    expect(features?.BSI).toBeLessThan(0);
  });
  it("finds deterministic low and high vegetation groups without labels",()=>{
    const samples:PostSpectralSample[]=[];
    for(let index=0;index<30;index++){
      const dense=extractPostSpectralFeatures({B02:.05,B03:.08,B04:.05+index*.0001,B08:.62,B11:.25,B12:.2,valid:true})!;
      const sparse=extractPostSpectralFeatures({B02:.14,B03:.16,B04:.2+index*.0001,B08:.3,B11:.28,B12:.27,valid:true})!;
      samples.push({month:5,features:dense},{month:9,features:sparse});
    }
    const first=clusterSpectralSamples(samples,2);
    const second=clusterSpectralSamples(samples,2);
    expect(first.clusters).toHaveLength(2);
    expect(first.assignments).toEqual(second.assignments);
    expect(first.clusters[0]!.centroid.NDVI).toBeLessThan(first.clusters[1]!.centroid.NDVI);
  });
});
