export function footprintIssue(points) {
  if (points.length < 3) return '至少点选 3 个角点。';
  const eps = 1e-9;
  const cross = (a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const onSegment = (a,b,p) => Math.abs(cross(a,b,p))<eps && p[0]>=Math.min(a[0],b[0])-eps && p[0]<=Math.max(a[0],b[0])+eps && p[1]>=Math.min(a[1],b[1])-eps && p[1]<=Math.max(a[1],b[1])+eps;
  for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
    if(Math.hypot(points[i][0]-points[j][0],points[i][1]-points[j][1])<1e-6) return '角点不能重复，最后直接点击「生成体块」即可闭合。';
  }
  for(let i=0;i<points.length;i++) for(let j=i+2;j<points.length;j++) {
    if(i===0&&j===points.length-1) continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || onSegment(a,b,c) || onSegment(a,b,d) || onSegment(c,d,a) || onSegment(c,d,b)) return '轮廓有交叉或重叠边，请撤销角点后重新描摹。';
  }
  const area=Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
  return area<0.000015 ? '轮廓面积太小，请描摹一个完整建筑。' : '';
}
