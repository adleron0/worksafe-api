import { Module } from '@nestjs/common';
import { GeocoderService } from './geocoder.service';
import { PlaceService } from './place.service';

/** Locais da empresa e pontos no mapa (com a conversão de endereço em ponto). */
@Module({ providers: [PlaceService, GeocoderService], exports: [PlaceService, GeocoderService] })
export class PlacesModule {}
