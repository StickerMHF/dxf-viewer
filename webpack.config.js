var path = require('path');
var CopyWebpackPlugin = require('copy-webpack-plugin');
//var UglifyJSPlugin = require('uglifyjs-webpack-plugin')
module.exports = {
    context: __dirname,
    devServer: {
        contentBase: './',//本地服务器所加载的页面所在的目录
        port:'8300',
        inline:true,//实时刷新
        hot: true
    },
    entry: {
        dxfView:"./src/index.js",
    },
    devtool:'cheap-module-eval-source-map',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: "static/[name].js",
        library: 'StickerMapCAD',
        libraryTarget: 'umd',
    },
    module: {
		rules: [
			// exclude 排除，不需要编译的目录，提高编译速度
			{
				test: /\.js$/,
				exclude: /node_modules/,
				use:{
					loader:'babel-loader',
					options:{
						presets:['@babel/preset-env']
					}
				}
				
			}
			
	
		]
	},
    plugins: [
        new CopyWebpackPlugin([{
            from: path.resolve(__dirname, './demo'),
            to: path.resolve(__dirname, './dist/static'),
            force: true
        }])
    ]
}